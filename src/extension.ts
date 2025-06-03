import * as vscode from "vscode";
import * as net from "net";
import * as fs from "fs";
import * as path from "path";

interface RenameRequest {
  action: "handshake" | "rename";
  requestId?: string;
  oldNamespace?: string;
  newNamespace?: string;
  oldClass?: string;
  newClass?: string;
  oldFile?: string;
  newFile?: string;
  unityPort?: number;
  projectRoot?: string;
}

interface UnityResponse {
  requestId?: string;
  status: "ok" | "error";
  message?: string;
  projectRoot?: string;
}

let server: net.Server | null = null;
let listeningPort: number | null = null;
let isDisposed = false;

export function activate(context: vscode.ExtensionContext) {
  // 1. Check for Unity‐project signature (both Assets/ and ProjectSettings/ at workspace root)
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    // No folder open at all → bail
    console.log("[scriptEdit] No workspace folder open. Skipping TCP server startup.");
    return;
  }

  const root = workspaceFolders[0].uri.fsPath;
  const assetsFolder = path.join(root, "Assets");
  const projectSettingsFolder = path.join(root, "ProjectSettings");
  if (!fs.existsSync(assetsFolder) || !fs.existsSync(projectSettingsFolder)) {
    // Not a Unity project → bail
    console.log(
      "[scriptEdit] Not a Unity project (missing Assets/ or ProjectSettings/). Skipping TCP server startup."
    );
    return;
  }

  // 2. Only now do we attempt to bind ports, knowing we’re in a Unity project
  const BASE_PORT = 39218;
  const MAX_OFFSET = 100;

  function tryListen(port: number): Promise<net.Server> {
    return new Promise((resolve, reject) => {
      const s = net.createServer(onSocket);

      s.once("error", (err: NodeJS.ErrnoException) => {
        if (err.code !== "EADDRINUSE" && err.code !== "EACCES") {
          console.error(`[scriptEdit] Unexpected listen() error on port ${port}:`, err);
        }
        try { s.close(); } catch {}
        reject(err);
      });

      s.once("listening", () => {
        s.removeAllListeners("error");
        resolve(s);
      });

      s.listen(port, "127.0.0.1");
    });
  }

  function onSocket(socket: net.Socket) {
    let dataBuffer = "";

    socket.on("data", (chunk) => {
      dataBuffer += chunk.toString();
      let newlineIndex: number;

      while ((newlineIndex = dataBuffer.indexOf("\n")) !== -1) {
        const message = dataBuffer.slice(0, newlineIndex);
        dataBuffer = dataBuffer.slice(newlineIndex + 1);

        let generic: any;
        try {
          generic = JSON.parse(message);
        } catch (e) {
          console.error("[scriptEdit] JSON parse error:", e);
          continue;
        }

        if (generic.action === "handshake") {
          const handshakeResponse: UnityResponse = {
            status: "ok",
            message: "handshake-ack"
          };
          socket.write(JSON.stringify(handshakeResponse) + "\n");
          socket.end();
          continue;
        }

        if (generic.action === "rename") {
          const req = generic as RenameRequest;
          const currentRoot = root;

          (async () => {
            try {
              if (req.projectRoot && currentRoot !== req.projectRoot) {
                throw new Error(
                  `Mismatched project root: '${currentRoot}' vs '${req.projectRoot}'`
                );
              }

              await handleRename(req);

              const okResp: UnityResponse = {
                requestId: req.requestId,
                status: "ok",
                projectRoot: req.projectRoot ?? currentRoot,
              };
              socket.write(JSON.stringify(okResp) + "\n");
              if (req.unityPort) {
                sendResponseToUnity(okResp, req.unityPort);
              }
              writeTempFile(okResp);
            } catch (err) {
              const msg = err instanceof Error ? err.stack || err.message : String(err);
              console.error("[scriptEdit] Rename‐side error:", msg);

              const errorPayload: UnityResponse = {
                requestId: req.requestId,
                status: "error",
                message: msg,
                projectRoot: req.projectRoot ?? currentRoot,
              };
              socket.write(JSON.stringify(errorPayload) + "\n");
              if (req.unityPort) {
                sendResponseToUnity(errorPayload, req.unityPort);
              }
              writeTempFile(errorPayload);
            }
          })();
        } else {
          const errorResp: UnityResponse = {
            status: "error",
            message: "Unknown action"
          };
          socket.write(JSON.stringify(errorResp) + "\n");
        }
      }
    });

    socket.on("error", (err) => {
      console.error("[scriptEdit] Socket error:", err);
    });
  }

  // 3. Now that we know it’s a Unity project, bind a port in [39218..39318]
  (async () => {
    for (let offset = 0; offset <= MAX_OFFSET; offset++) {
      const attemptPort = BASE_PORT + offset;
      try {
        server = await tryListen(attemptPort);
        listeningPort = attemptPort;
        console.log(`[scriptEdit] Listening on tcp://127.0.0.1:${listeningPort}`);

        server.on("error", (err) => {
          console.error("[scriptEdit] Runtime server error:", err);
        });

        context.subscriptions.push({
          dispose: () => {
            if (server) {
              server.close();
              console.log(`[scriptEdit] Closed listener on port ${listeningPort}`);
            }
          },
        });
        return;
      } catch (err: any) {
        if (err.code === "EADDRINUSE" || err.code === "EACCES") {
          continue; // try next port
        }
        console.error("[scriptEdit] Unexpected bind error:", err);
        vscode.window.showErrorMessage(
          `scriptEdit: failed to bind TCP port (error: ${err.message}).`
        );
        return;
      }
    }

    vscode.window.showErrorMessage(
      "scriptEdit: could not bind any TCP port in range 39218–39318. Extension will not run."
    );
  })();
}

async function handleRename(req: RenameRequest) {
  if (req.oldNamespace && req.newNamespace) {
    await doLspRename(req.oldNamespace, req.newNamespace);
  }
  if (req.oldClass && req.newClass) {
    await doLspRename(req.oldClass, req.newClass);
  }
  if (req.newFile) {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(req.newFile));
    await vscode.window.showTextDocument(doc);
  }
}

async function doLspRename(oldSym: string, newSym: string) {
  const symbols = (await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
    "vscode.executeWorkspaceSymbolProvider",
    oldSym
  )) ?? [];
  const match = symbols.find(si => si.name === oldSym);
  if (!match) {
    throw new Error(`Symbol '${oldSym}' not found.`);
  }

  const edit = await vscode.commands.executeCommand(
    "vscode.executeDocumentRenameProvider",
    match.location.uri,
    match.location.range.start,
    newSym
  );
  if (!edit) {
    throw new Error(`Rename of '${oldSym}' failed (no edits).`);
  }

  const applied = await vscode.workspace.applyEdit(edit as vscode.WorkspaceEdit);
  if (!applied) {
    throw new Error(`Rename of '${oldSym}' failed to apply.`);
  }

  await vscode.workspace.saveAll();
}

function sendResponseToUnity(response: UnityResponse, port: number) {
  const client = new net.Socket();
  client.connect(port, "127.0.0.1", () => {
    client.write(JSON.stringify(response) + "\n");
    client.end();
  });
  client.on("error", (err) => {
    console.error("[scriptEdit] Send‐back error:", err);
  });
}

function writeTempFile(response: UnityResponse) {
  const tempDir = path.join(require("os").tmpdir(), "vscode-scriptEdit");
  try {
    fs.mkdirSync(tempDir, { recursive: true });
    const outPath = path.join(tempDir, `last_response.json`);
    fs.writeFileSync(outPath, JSON.stringify(response, null, 2), "utf8");
    console.log(`[scriptEdit] Wrote response to temp file: ${outPath}`);
  } catch (err) {
    console.error("[scriptEdit] Failed to write temp file:", err);
  }
}

export function deactivate() {
  isDisposed = true;
  if (server) {
    try { server.close(); } catch {}
  }
}
