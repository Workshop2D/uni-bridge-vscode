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
let server = null;
let listeningPort = null;
let isDisposed = false;
function activate(context) {
    const DEFAULT_PORT = 39217;
    const MIN_PORT = 1024;
    const MAX_PORT = 65535;
    function tryListen(port) {
        return new Promise((resolve, reject) => {
            const s = net.createServer(onSocket);
            s.once("error", (err) => {
                // Bind error—close & reject
                if (err.code !== "EADDRINUSE" && err.code !== "EACCES") {
                    console.error(`[scriptEdit] Unexpected listen() error on port ${port}:`, err);
                }
                try {
                    s.close();
                }
                catch { /* no-op */ }
                reject(err);
            });
            s.once("listening", () => {
                s.removeAllListeners("error");
                resolve(s);
            });
            s.listen(port, "127.0.0.1");
        });
    }
    function onSocket(socket) {
        let dataBuffer = "";
        socket.on("data", (chunk) => {
            dataBuffer += chunk.toString();
            let newlineIndex;
            while ((newlineIndex = dataBuffer.indexOf("\n")) !== -1) {
                const message = dataBuffer.slice(0, newlineIndex);
                dataBuffer = dataBuffer.slice(newlineIndex + 1);
                let generic;
                try {
                    generic = JSON.parse(message);
                }
                catch (e) {
                    console.error("[scriptEdit] JSON parse error:", e);
                    continue; // malformed JSON—ignore
                }
                // ── 1) If it’s a “handshake” probe, answer immediately and close
                if (generic.action === "handshake") {
                    const handshakeResponse = {
                        status: "ok",
                        message: "handshake-ack"
                    };
                    socket.write(JSON.stringify(handshakeResponse) + "\n");
                    socket.end();
                    continue;
                }
                // ── 2) Otherwise, treat it as a “rename” request
                if (generic.action === "rename") {
                    const req = generic;
                    const currentRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
                    if (req.projectRoot && currentRoot !== req.projectRoot) {
                        const errorResp = {
                            requestId: req.requestId,
                            status: "error",
                            message: `Mismatched project root: '${currentRoot}' vs '${req.projectRoot}'`,
                        };
                        socket.write(JSON.stringify(errorResp) + "\n");
                        continue;
                    }
                    handleRename(req)
                        .then(() => {
                        const okResp = {
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
                        const errorPayload = {
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
                    const errorResp = {
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
        const triedPorts = new Set();
        let attemptPort = DEFAULT_PORT;
        while (true) {
            if (isDisposed) {
                console.log("[scriptEdit] Activation disposed before binding; exiting.");
                return;
            }
            if (triedPorts.has(attemptPort)) {
                if (triedPorts.size >= MAX_PORT - MIN_PORT + 1) {
                    console.error("[scriptEdit] No available ports left in 1024–65535.");
                    vscode.window.showErrorMessage("scriptEdit: could not bind any TCP port. Extension will not run.");
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
            }
            catch (err) {
                if (err.code === "EADDRINUSE" || err.code === "EACCES") {
                    if (attemptPort === DEFAULT_PORT) {
                        attemptPort = Math.floor(Math.random() * (MAX_PORT - MIN_PORT + 1)) + MIN_PORT;
                    }
                    continue;
                }
                console.error("[scriptEdit] Unexpected bind error:", err);
                vscode.window.showErrorMessage(`scriptEdit: failed to bind TCP port (error: ${err.message}).`);
                return;
            }
        }
    })();
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
    const symbols = (await vscode.commands.executeCommand("vscode.executeWorkspaceSymbolProvider", oldSym)) ?? [];
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
        throw new Error(`Rename of '${oldSym}' failed to apply.`);
    }
    await vscode.workspace.saveAll();
}
function sendResponseToUnity(response, port) {
    const client = new net.Socket();
    client.connect(port, "127.0.0.1", () => {
        client.write(JSON.stringify(response) + "\n");
        client.end();
    });
    client.on("error", (err) => {
        console.error("[scriptEdit] Send‐back error:", err);
    });
}
function deactivate() {
    isDisposed = true;
    if (server) {
        try {
            server.close();
        }
        catch { /* no-op */ }
    }
}
//# sourceMappingURL=extension.js.map