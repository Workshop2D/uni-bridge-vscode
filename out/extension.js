"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const net = __importStar(require("net"));
let server;
function activate(context) {
    server = net.createServer(socket => {
        let dataBuffer = "";
        socket.on("data", chunk => {
            dataBuffer += chunk.toString();
            let newlineIndex;
            while ((newlineIndex = dataBuffer.indexOf("\n")) !== -1) {
                const message = dataBuffer.slice(0, newlineIndex);
                dataBuffer = dataBuffer.slice(newlineIndex + 1);
                try {
                    const req = JSON.parse(message);
                    const currentRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
                    if (req.projectRoot && currentRoot !== req.projectRoot) {
                        const errorResp = {
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
                            const okResp = {
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
                            const errorPayload = {
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
                    }
                    else {
                        const errorResp = {
                            requestId: req.requestId,
                            status: "error",
                            message: "Unknown action",
                            projectRoot: req.projectRoot ?? currentRoot
                        };
                        socket.write(JSON.stringify(errorResp) + "\n");
                    }
                }
                catch (e) {
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
async function handleRename(req) {
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
async function doLspRename(oldSym, newSym) {
    const symbols = (await vscode.commands.executeCommand("vscode.executeWorkspaceSymbolProvider", oldSym)) || [];
    const match = symbols.find(si => si.name === oldSym);
    if (!match) {
        throw new Error(`Symbol '${oldSym}' not found.`);
    }
    const edit = await vscode.commands.executeCommand("vscode.executeDocumentRenameProvider", match.location.uri, match.location.range.start, newSym);
    if (!edit) {
        throw new Error(`Rename of '${oldSym}' failed (no edits).`);
    }
    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) {
        throw new Error(`Rename of '${oldSym}' failed on applyEdit.`);
    }
    await vscode.workspace.saveAll();
}
function sendResponseToUnity(response, port) {
    const client = new net.Socket();
    client.connect(port, "127.0.0.1", () => {
        client.write(JSON.stringify(response) + "\n");
        client.end();
    });
    client.on("error", err => {
        console.error("[scriptEdit] Failed to send back to Unity:", err);
    });
}
function deactivate() {
    server.close();
}
//# sourceMappingURL=extension.js.map