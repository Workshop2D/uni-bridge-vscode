import * as vscode from "vscode";
import * as net from "net";

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
  const DEFAULT_PORT = 39217;
  const MIN_PORT = 1024;
  const MAX_PORT = 65535;

  function tryListen(port: number): Promise<net.Server> {
    return new Promise((resolve, reject) => {
      const s = net.createServer(onSocket);

      s.once("error", (err: NodeJS.ErrnoException) => {
        // Bind error—close & reject
        if (err.code !== "EADDRINUSE" && err.code !== "EACCES") {
          console.error(`[scriptEdit] Unexpected listen() error on port ${port}:`, err);
        }
        try { s.close(); } catch { /* no-op */ }
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
          continue; // malformed JSON—ignore
        }

        // ── 1) If it’s a “handshake” probe, answer immediately and close
        if (generic.action === "handshake") {
          const handshakeResponse: UnityResponse = {
            status: "ok",
            message: "handshake-ack"
          };
          socket.write(JSON.stringify(handshakeResponse) + "\n");
          socket.end();
          continue;
        }

        // ── 2) Otherwise, treat it as a “rename” request
        if (generic.action === "rename") {
          const req = generic as RenameRequest;

          const currentRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
          if (req.projectRoot && currentRoot !== req.projectRoot) {
            const errorResp: UnityResponse = {
              requestId: req.requestId,
              status: "error",
              message: `Mismatched project root: '${currentRoot}' vs '${req.projectRoot}'`,
            };
            socket.write(JSON.stringify(errorResp) + "\n");
            continue;
          }

          handleRename(req)
            .then(() => {
              const okResp: UnityResponse = {
                requestId: req.requestId,
                status: "ok",
                projectRoot: req.projectRoot ?? currentRoot,
              };
              socket.write(JSON.stringify(okResp) + "\n");
              if (req.unityPort) {
                sendResponseToUnity(okResp, req.unityPort);
              }
            })
            .catch((renErr) => {
              const msg = renErr instanceof Error ? renErr.message : String(renErr);
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
            });
        }
        else {
          // Unknown action—reply with error
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

  (async () => {
    const triedPorts = new Set<number>();
    let attemptPort = DEFAULT_PORT;

    while (true) {
      if (isDisposed) {
        console.log("[scriptEdit] Activation disposed before binding; exiting.");
        return;
      }

      if (triedPorts.has(attemptPort)) {
        if (triedPorts.size >= MAX_PORT - MIN_PORT + 1) {
          console.error("[scriptEdit] No available ports left in 1024–65535.");
          vscode.window.showErrorMessage(
            "scriptEdit: could not bind any TCP port. Extension will not run."
          );
          return;
        }
        do {
          attemptPort = Math.floor(Math.random() * (MAX_PORT - MIN_PORT + 1)) + MIN_PORT;
        } while (triedPorts.has(attemptPort));
      }

      triedPorts.add(attemptPort);

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

        break;
      } catch (err: any) {
        if (err.code === "EADDRINUSE" || err.code === "EACCES") {
          if (attemptPort === DEFAULT_PORT) {
            attemptPort = Math.floor(Math.random() * (MAX_PORT - MIN_PORT + 1)) + MIN_PORT;
          }
          continue;
        }

        console.error("[scriptEdit] Unexpected bind error:", err);
        vscode.window.showErrorMessage(
          `scriptEdit: failed to bind TCP port (error: ${err.message}).`
        );
        return;
      }
    }
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
  if (!match) {throw new Error(`Symbol '${oldSym}' not found.`);}

  const edit = await vscode.commands.executeCommand(
    "vscode.executeDocumentRenameProvider",
    match.location.uri,
    match.location.range.start,
    newSym
  );
  if (!edit) {throw new Error(`Rename of '${oldSym}' failed (no edits).`);
}
  const applied = await vscode.workspace.applyEdit(edit as vscode.WorkspaceEdit);
  if (!applied) {throw new Error(`Rename of '${oldSym}' failed to apply.`);
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

export function deactivate() {
  isDisposed = true;
  if (server) {
    try { server.close(); } catch { /* no-op */ }
  }
}
