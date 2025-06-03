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
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
let server = null;
let listeningPort = null;
let isDisposed = false;
function activate(context) {
    // 1. Check for Unity‐project signature (both Assets/ and ProjectSettings/ at workspace root)
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        console.log("[scriptEdit] No workspace folder open. Skipping TCP server startup.");
        return;
    }
    const root = workspaceFolders[0].uri.fsPath;
    const assetsFolder = path.join(root, "Assets");
    const projectSettingsFolder = path.join(root, "ProjectSettings");
    if (!fs.existsSync(assetsFolder) || !fs.existsSync(projectSettingsFolder)) {
        console.log("[scriptEdit] Not a Unity project (missing Assets/ or ProjectSettings/). Skipping TCP server startup.");
        return;
    }
    // 2. Only now do we attempt to bind ports, knowing we’re in a Unity project
    const BASE_PORT = 39218;
    const MAX_OFFSET = 100;
    function tryListen(port) {
        return new Promise((resolve, reject) => {
            const s = net.createServer(onSocket);
            s.once("error", (err) => {
                if (err.code !== "EADDRINUSE" && err.code !== "EACCES") {
                    console.error(`[scriptEdit] Unexpected listen() error on port ${port}:`, err);
                }
                try {
                    s.close();
                }
                catch { }
                reject(err);
            });
            s.once("listening", () => {
                s.removeAllListeners("error");
                resolve(s);
            });
            s.listen(port, "127.0.0.1");
        });
    }
    // Normalize a path: replace backslashes with forward slashes, remove trailing slash, lowercase on Windows
    function normalizePath(p) {
        if (!p) {
            return p;
        }
        let np = p.replace(/\\/g, "/");
        if (np.endsWith("/")) {
            np = np.slice(0, -1);
        }
        // On Windows, paths are case‐insensitive
        if (process.platform === "win32") {
            np = np.toLowerCase();
        }
        return np;
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
                    continue;
                }
                // ── 1) Handshake: verify projectRoot before replying ─────────────────────
                if (generic.action === "handshake") {
                    const reqRootRaw = generic.projectRoot ?? "";
                    const wsRootRaw = root;
                    const reqRoot = normalizePath(reqRootRaw);
                    const wsRoot = normalizePath(wsRootRaw);
                    if (!reqRoot) {
                        const errorResp = {
                            status: "error",
                            message: "handshake missing projectRoot"
                        };
                        socket.write(JSON.stringify(errorResp) + "\n");
                        socket.end();
                        continue;
                    }
                    if (reqRoot !== wsRoot) {
                        const errorResp = {
                            status: "error",
                            message: `Mismatched project root: '${wsRootRaw}' vs '${reqRootRaw}'`
                        };
                        socket.write(JSON.stringify(errorResp) + "\n");
                        socket.end();
                        continue;
                    }
                    const handshakeResponse = {
                        status: "ok",
                        message: "handshake-ack",
                        projectRoot: wsRootRaw
                    };
                    socket.write(JSON.stringify(handshakeResponse) + "\n");
                    socket.end();
                    continue;
                }
                // ── 2) Rename: as before, but reuse root for comparison ─────────────────────
                if (generic.action === "rename") {
                    const req = generic;
                    const currentRootRaw = root;
                    const currentRoot = normalizePath(currentRootRaw);
                    (async () => {
                        try {
                            if (req.projectRoot) {
                                const reqRootNorm = normalizePath(req.projectRoot);
                                if (reqRootNorm !== currentRoot) {
                                    throw new Error(`Mismatched project root: '${currentRootRaw}' vs '${req.projectRoot}'`);
                                }
                            }
                            await handleRename(req);
                            const okResp = {
                                requestId: req.requestId,
                                status: "ok",
                                projectRoot: req.projectRoot ?? currentRootRaw,
                            };
                            socket.write(JSON.stringify(okResp) + "\n");
                            if (req.unityPort) {
                                sendResponseToUnity(okResp, req.unityPort);
                            }
                            writeTempFile(okResp);
                        }
                        catch (err) {
                            const msg = err instanceof Error ? err.stack || err.message : String(err);
                            console.error("[scriptEdit] Rename‐side error:", msg);
                            const errorPayload = {
                                requestId: req.requestId,
                                status: "error",
                                message: msg,
                                projectRoot: req.projectRoot ?? currentRootRaw,
                            };
                            socket.write(JSON.stringify(errorPayload) + "\n");
                            if (req.unityPort) {
                                sendResponseToUnity(errorPayload, req.unityPort);
                            }
                            writeTempFile(errorPayload);
                        }
                    })();
                }
                else {
                    // ── 3) Unknown action ────────────────────────────────────────────────────
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
            }
            catch (err) {
                if (err.code === "EADDRINUSE" || err.code === "EACCES") {
                    continue; // try next port
                }
                console.error("[scriptEdit] Unexpected bind error:", err);
                vscode.window.showErrorMessage(`scriptEdit: failed to bind TCP port (error: ${err.message}).`);
                return;
            }
        }
        vscode.window.showErrorMessage("scriptEdit: could not bind any TCP port in range 39218–39318. Extension will not run.");
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
function writeTempFile(response) {
    const tempDir = path.join(require("os").tmpdir(), "vscode-scriptEdit");
    try {
        fs.mkdirSync(tempDir, { recursive: true });
        const outPath = path.join(tempDir, `last_response.json`);
        fs.writeFileSync(outPath, JSON.stringify(response, null, 2), "utf8");
        console.log(`[scriptEdit] Wrote response to temp file: ${outPath}`);
    }
    catch (err) {
        console.error("[scriptEdit] Failed to write temp file:", err);
    }
}
function deactivate() {
    isDisposed = true;
    if (server) {
        try {
            server.close();
        }
        catch { }
    }
}
//# sourceMappingURL=extension.js.map