import * as vscode from "vscode";
import * as net from "net";

interface RenameRequest {
  action: "rename";
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
  status: "ok" | "error";
  message?: string;
  projectRoot: string;
}

let server: net.Server;

export function activate(context: vscode.ExtensionContext) {
  server = net.createServer(socket => {
    let dataBuffer = "";

    socket.on("data", async chunk => {
      dataBuffer += chunk.toString();

      try {
        const req = JSON.parse(dataBuffer) as RenameRequest;
        dataBuffer = "";

        const currentRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (req.projectRoot && currentRoot !== req.projectRoot) {
          socket.write(JSON.stringify({
            status: "error",
            message: `Mismatched project root: expected '${currentRoot}', got '${req.projectRoot}'`,
            projectRoot: req.projectRoot,
          } satisfies UnityResponse));
          return;
        }

        if (req.action === "rename") {
          try {
            await handleRename(req);
            socket.write(JSON.stringify({
              status: "ok",
              projectRoot: req.projectRoot ?? currentRoot ?? ""
            } satisfies UnityResponse));

            if (req.unityPort) {
              sendResponseToUnity({
                status: "ok",
                projectRoot: req.projectRoot ?? currentRoot ?? ""
              }, req.unityPort);
            }
          } catch (renErr) {
            const message = renErr instanceof Error ? renErr.message : String(renErr);
            const errorPayload: UnityResponse = {
              status: "error",
              message,
              projectRoot: req.projectRoot ?? currentRoot ?? ""
            };
            socket.write(JSON.stringify(errorPayload));
            if (req.unityPort) {
              sendResponseToUnity(errorPayload, req.unityPort);
            }
          }
        } else {
          socket.write(JSON.stringify({
            status: "error",
            message: "Unknown action",
            projectRoot: req.projectRoot ?? currentRoot ?? ""
          } satisfies UnityResponse));
        }
      } catch {
        // Buffer incomplete
      }
    });

    socket.on("error", err => {
      console.error("[scriptEdit] Socket error:", err);
    });
  });

  server.listen(39217, "127.0.0.1", () => {
    console.log("[scriptEdit] Listening on ws://127.0.0.1:39217");
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
  if (!match) {throw new Error(`Symbol '${oldSym}' not found.`);
}
  const edit = await vscode.commands.executeCommand<vscode.WorkspaceEdit>(
    "vscode.executeDocumentRenameProvider",
    match.location.uri,
    match.location.range.start,
    newSym
  );

  if (!edit) {throw new Error(`Rename of '${oldSym}' failed (no edits).`);}
  const applied = await vscode.workspace.applyEdit(edit);
  if (!applied) {throw new Error(`Rename of '${oldSym}' failed on applyEdit.`);}
  await vscode.workspace.saveAll();
}

function sendResponseToUnity(response: UnityResponse, port: number) {
  const client = new net.Socket();
  client.connect(port, "127.0.0.1", () => {
    client.write(JSON.stringify(response));
    client.end();
  });
  client.on("error", err => {
    console.error("[scriptEdit] Failed to send back to Unity:", err);
  });
}

export function deactivate() {
  server.close();
}
