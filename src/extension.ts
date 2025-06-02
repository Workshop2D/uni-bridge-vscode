import * as vscode from "vscode";
import * as net from "net";

interface RenameRequest {
  action: "rename";
  requestId: string;
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
  requestId: string;
  status: "ok" | "error";
  message?: string;
  projectRoot: string;
}

let server: net.Server;

export function activate(context: vscode.ExtensionContext) {
  server = net.createServer(socket => {
    let dataBuffer = "";

    socket.on("data", chunk => {
      dataBuffer += chunk.toString();

      let newlineIndex: number;
      while ((newlineIndex = dataBuffer.indexOf("\n")) !== -1) {
        const message = dataBuffer.slice(0, newlineIndex);
        dataBuffer = dataBuffer.slice(newlineIndex + 1);

        try {
          const req = JSON.parse(message) as RenameRequest;

          const currentRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
          if (req.projectRoot && currentRoot !== req.projectRoot) {
            const errorResp: UnityResponse = {
              requestId: req.requestId,
              status: "error",
              message: `Mismatched project root: expected '${currentRoot}', got '${req.projectRoot}'`,
              projectRoot: req.projectRoot,
            };
            socket.write(JSON.stringify(errorResp) + "\n");
            continue;
          }

          if (req.action === "rename") {
            handleRename(req).then(() => {
              const okResp: UnityResponse = {
                requestId: req.requestId,
                status: "ok",
                projectRoot: req.projectRoot ?? currentRoot
              };
              socket.write(JSON.stringify(okResp) + "\n");

              if (req.unityPort) {
                sendResponseToUnity(okResp, req.unityPort);
              }
            }).catch(renErr => {
              const message = renErr instanceof Error ? renErr.message : String(renErr);
              const errorPayload: UnityResponse = {
                requestId: req.requestId,
                status: "error",
                message,
                projectRoot: req.projectRoot ?? currentRoot
              };
              socket.write(JSON.stringify(errorPayload) + "\n");
              if (req.unityPort) {
                sendResponseToUnity(errorPayload, req.unityPort);
              }
            });
          } else {
            const errorResp: UnityResponse = {
              requestId: req.requestId,
              status: "error",
              message: "Unknown action",
              projectRoot: req.projectRoot ?? currentRoot
            };
            socket.write(JSON.stringify(errorResp) + "\n");
          }
        } catch (e) {
          console.error("[scriptEdit] JSON parse error:", e);
          // ignore malformed or partial JSON
        }
      }
    });

    socket.on("error", err => {
      console.error("[scriptEdit] Socket error:", err);
    });

    socket.on("close", () => {
      // Optional
    });
  });

  server.listen(39217, "127.0.0.1", () => {
    console.log("[scriptEdit] Listening on tcp://127.0.0.1:39217");
  });

  context.subscriptions.push({ dispose: () => server.close() });
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
  )) || [];

  const match = symbols.find(si => si.name === oldSym);
  if (!match) { throw new Error(`Symbol '${oldSym}' not found.`); }

  const edit = await vscode.commands.executeCommand<vscode.WorkspaceEdit>(
    "vscode.executeDocumentRenameProvider",
    match.location.uri,
    match.location.range.start,
    newSym
  );

  if (!edit) { throw new Error(`Rename of '${oldSym}' failed (no edits).`); }

  const applied = await vscode.workspace.applyEdit(edit);
  if (!applied) { throw new Error(`Rename of '${oldSym}' failed on applyEdit.`); }

  await vscode.workspace.saveAll();
}

function sendResponseToUnity(response: UnityResponse, port: number) {
  const client = new net.Socket();
  client.connect(port, "127.0.0.1", () => {
    client.write(JSON.stringify(response) + "\n");
    client.end();
  });
  client.on("error", err => {
    console.error("[scriptEdit] Failed to send back to Unity:", err);
  });
}

export function deactivate() {
  server.close();
}
