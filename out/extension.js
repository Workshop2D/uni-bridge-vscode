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
exports.doLspRename = doLspRename;
exports.saveEditedFiles = saveEditedFiles;
const vscode = __importStar(require("vscode"));
const net = __importStar(require("net"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
var RenameSymbolKind;
(function (RenameSymbolKind) {
    RenameSymbolKind[RenameSymbolKind["Class"] = 5] = "Class";
    RenameSymbolKind[RenameSymbolKind["Namespace"] = 3] = "Namespace";
})(RenameSymbolKind || (RenameSymbolKind = {}));
// --- Module-level state ---
let server = null;
let listeningPort = null;
let lastSeenUnityIP = null;
let unityPort = null; // port provided by Unity during handshake
function activate(context) {
    lastSeenUnityIP = "127.0.0.1";
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
    const BASE_PORT = 39218;
    // MAX_OFFSET_UPWARDS defines how far to search above BASE_PORT (i.e. trying BASE_PORT + 0 up to BASE_PORT + MAX_OFFSET_UPWARDS)
    const MAX_OFFSET_UPWARDS = 100;
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
    function normalizePath(p) {
        if (!p) {
            return p;
        }
        let np = p.replace(/\\/g, "/");
        if (np.endsWith("/")) {
            np = np.slice(0, -1);
        }
        return process.platform === "win32" ? np.toLowerCase() : np;
    }
    function sendUnityResponse(resp) {
        if (!lastSeenUnityIP || unityPort === null) {
            if (!lastSeenUnityIP && unityPort === null) {
                console.warn("[scriptEdit] Cannot send UnityResponse: missing IP and port");
            }
            else if (!lastSeenUnityIP) {
                console.warn("[scriptEdit] Cannot send UnityResponse: missing IP");
            }
            else {
                console.warn("[scriptEdit] Cannot send UnityResponse: missing port");
            }
            return;
        }
        console.warn("[scriptEdit] Sending response on port: " + unityPort);
        const client = new net.Socket();
        client.connect(unityPort, lastSeenUnityIP, () => {
            const payload = JSON.stringify(resp) + "\n";
            client.write(payload, (err) => {
                if (err) {
                    console.error("[scriptEdit] Error writing UnityResponse:", err);
                }
                client.end();
            });
        });
        client.on("error", (err) => {
            console.error("[scriptEdit] Socket error when sending UnityResponse:", err);
        });
    }
    async function handleRequest(socket, generic) {
        // Wrap entire logic to catch unexpected errors
        try {
            // Check action field
            if (!generic || typeof generic.action !== "string") {
                const resp = { status: "error", message: "Missing or invalid action field" };
                sendUnityResponse(resp);
                return;
            }
            // Normalize and validate projectRoot for both handshake and batchRename
            const rawReq = normalizePath(generic.projectRoot ?? "");
            const wsRoot = normalizePath(root);
            const requestId = generic.requestId;
            if (generic.action === "handshake") {
                // Validate handshake payload
                if (!rawReq) {
                    const msg = "Missing projectRoot for handshake";
                    console.warn(`[scriptEdit] ${msg}`);
                    const resp = { status: "error", message: msg, requestId };
                    sendUnityResponse(resp);
                    return;
                }
                if (typeof generic.unityPort !== "number") {
                    const msg = "Missing or invalid unityPort for handshake";
                    console.warn(`[scriptEdit] ${msg}`);
                    const resp = { status: "error", message: msg, requestId };
                    sendUnityResponse(resp);
                    return;
                }
                // Accept subfolders (e.g. Assets) as valid root
                let reqRoot = rawReq;
                const rel = path.relative(wsRoot, reqRoot);
                if (!rel.startsWith("..")) {
                    reqRoot = wsRoot;
                }
                if (reqRoot !== wsRoot) {
                    const msg = `Mismatched project root: '${root}' vs '${generic.projectRoot}'`;
                    console.warn(`[scriptEdit] ${msg}`);
                    const resp = { status: "error", message: msg, requestId };
                    sendUnityResponse(resp);
                    return;
                }
                // Handle handshake success
                lastSeenUnityIP = socket.remoteAddress ?? null;
                unityPort = generic.unityPort;
                console.log(`[scriptEdit] Handshake from ${lastSeenUnityIP}:${unityPort}`);
                // Build the response JSON:
                const respObj = {
                    status: "ok",
                    message: "handshake-ack",
                    projectRoot: root,
                    requestId
                };
                const respJson = JSON.stringify(respObj) + "\n";
                // Send it immediately over the same socket:
                socket.write(respJson, (err) => {
                    if (err) {
                        console.error("[scriptEdit] Error writing handshake‐reply on same socket:", err);
                    }
                    // (You can optionally end() the socket here if you don't expect anything more on it:)
                    socket.end();
                });
                return;
            }
            if (generic.action === "batchRename") {
                // Validate batchRename payload
                if (!rawReq) {
                    const msg = "Missing projectRoot for batchRename";
                    console.warn(`[scriptEdit] ${msg}`);
                    const resp = { status: "error", message: msg, requestId };
                    sendUnityResponse(resp);
                    return;
                }
                // Accept subfolders as valid root
                let reqRoot = rawReq;
                const rel = path.relative(wsRoot, reqRoot);
                if (!rel.startsWith("..")) {
                    reqRoot = wsRoot;
                }
                if (reqRoot !== wsRoot) {
                    const msg = `Mismatched project root: '${root}' vs '${generic.projectRoot}'`;
                    console.warn(`[scriptEdit] ${msg}`);
                    const resp = { status: "error", message: msg, requestId };
                    sendUnityResponse(resp);
                    return;
                }
                if (!Array.isArray(generic.requests) || generic.requests.length === 0) {
                    const msg = "BatchRename request must include a non-empty requests array";
                    console.warn(`[scriptEdit] ${msg}`);
                    const resp = { status: "error", message: msg, requestId };
                    sendUnityResponse(resp);
                    return;
                }
                // Perform all renames
                // Collect file rename operations for later
                const editedFilesSet = new Set();
                const fileRenameQueue = [];
                // Perform all symbol renames (namespace/class) first
                for (let idx = 0; idx < generic.requests.length; idx++) {
                    const req = generic.requests[idx];
                    if (!req.oldNamespace && !req.newNamespace && !req.oldClass && !req.newClass && !req.newFile) {
                        const msg = `Rename entry at index ${idx} has no valid rename fields`;
                        console.warn(`[scriptEdit] ${msg}`);
                        const resp = { status: "error", message: msg, requestId };
                        sendUnityResponse(resp);
                        return;
                    }
                    // Namespace rename
                    if (req.oldNamespace && req.newNamespace) {
                        try {
                            const editedUris = await doLspRename(req.oldNamespace, req.newNamespace, vscode.SymbolKind.Namespace, req.oldFile);
                            editedUris.forEach(u => editedFilesSet.add(u.fsPath));
                        }
                        catch (e) {
                            const msg = `Namespace rename failed for '${req.oldNamespace}' -> '${req.newNamespace}': ${e instanceof Error ? e.message : String(e)}`;
                            console.error(`[scriptEdit] ${msg}`);
                            const resp = { status: "error", message: msg, requestId };
                            sendUnityResponse(resp);
                        }
                    }
                    // Class rename
                    if (req.oldClass && req.newClass) {
                        try {
                            const editedUris = await doLspRename(req.oldClass, req.newClass, vscode.SymbolKind.Class, req.oldFile);
                            editedUris.forEach(u => editedFilesSet.add(u.fsPath));
                        }
                        catch (e) {
                            const msg = `Class rename failed for '${req.oldClass}' -> '${req.newClass}': ${e instanceof Error ? e.message : String(e)}`;
                            console.error(`[scriptEdit] ${msg}`);
                            const resp = { status: "error", message: msg, requestId };
                            sendUnityResponse(resp);
                        }
                    }
                    // Collect file rename to do later
                    if (req.oldFile && req.newFile) {
                        fileRenameQueue.push({ oldFile: req.oldFile, newFile: req.newFile });
                        console.warn("Pushing file to rename later");
                    }
                }
                console.log(`[scriptEdit] Completed namespace and class rename loop.`);
                // …inside your batchRename handler, after all doLspRename calls and after
                // you’ve pushed into fileRenameQueue…
                // DEBUG: How many files did LSP edits touch, and what are they?
                const editedArray = Array.from(editedFilesSet);
                console.log(`[scriptEdit] editedFilesSet size=${editedFilesSet.size}. Contents:`, editedArray);
                // DEBUG: How many file‐move operations are queued, and what are they?
                console.log(`[scriptEdit] fileRenameQueue length=${fileRenameQueue.length}. Contents:`, fileRenameQueue);
                // Now you can save or rename.
                //
                // await saveEditedFiles(editedFilesSet);
                // for (const { oldFile, newFile } of fileRenameQueue) { … }
                await saveEditedFiles(editedFilesSet);
                // After all class/namespace renames, perform file renames
                for (const { oldFile, newFile } of fileRenameQueue) {
                    const oldUri = vscode.Uri.file(oldFile);
                    const newUri = vscode.Uri.file(newFile);
                    try {
                        await vscode.workspace.fs.rename(oldUri, newUri);
                        console.log(`[scriptEdit] File renamed from '${oldFile}' to '${newFile}'`);
                    }
                    catch (fsErr) {
                        const msg = `File rename error for '${oldFile}' -> '${newFile}': ${fsErr instanceof Error ? fsErr.message : String(fsErr)}`;
                        console.error(`[scriptEdit] ${msg}`);
                        const resp = { status: "error", message: msg, requestId };
                        sendUnityResponse(resp);
                        return;
                    }
                    try {
                        const doc = await vscode.workspace.openTextDocument(newUri);
                        await vscode.window.showTextDocument(doc);
                    }
                    catch (openErr) {
                        console.warn(`[scriptEdit] Open file failed for '${newFile}': ${openErr}`);
                        // Not fatal
                    }
                }
                // All entries succeeded
                const resp = { status: "ok", requestId };
                sendUnityResponse(resp);
                return;
            }
            // Unknown action
            const msg = `Unknown action '${generic.action}'`;
            console.warn(`[scriptEdit] ${msg}`);
            const resp = { status: "error", message: msg, requestId };
            sendUnityResponse(resp);
        }
        catch (err) {
            const msg = `Unexpected error: ${err instanceof Error ? err.message : String(err)}`;
            console.error(`[scriptEdit] ${msg}`);
            const resp = { status: "error", message: msg, requestId: (generic && generic.requestId) };
            sendUnityResponse(resp);
        }
    }
    function onSocket(socket) {
        console.log("[scriptEdit] New client connection from", socket.remoteAddress);
        let dataBuffer = "";
        socket.on("data", (chunk) => {
            dataBuffer += chunk.toString();
            let newlineIndex;
            while ((newlineIndex = dataBuffer.indexOf("\n")) !== -1) {
                const message = dataBuffer.slice(0, newlineIndex);
                dataBuffer = dataBuffer.slice(newlineIndex + 1);
                console.log("[scriptEdit] Raw incoming message:", message);
                let parsed;
                try {
                    parsed = JSON.parse(message);
                }
                catch (e) {
                    const msg = `[scriptEdit] JSON parse error: ${e}`;
                    console.error(msg);
                    const resp = { status: "error", message: msg };
                    sendUnityResponse(resp);
                    continue;
                }
                handleRequest(socket, parsed);
            }
        });
        socket.on("error", (err) => {
            console.error("[scriptEdit] Socket error:", err);
        });
        socket.on("close", () => {
            console.log("[scriptEdit] Client disconnected.");
        });
    }
    // Attempt to bind server
    (async () => {
        for (let offset = 0; offset <= MAX_OFFSET_UPWARDS; offset++) {
            try {
                const attemptPort = BASE_PORT + offset;
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
                if (err.code !== "EADDRINUSE" && err.code !== "EACCES") {
                    vscode.window.showErrorMessage(`scriptEdit: failed to bind TCP port: ${err.message}`);
                    return;
                }
            }
        }
        vscode.window.showErrorMessage("scriptEdit: could not bind any TCP port in range 39218–39318. Extension will not run.");
    })();
}
async function doLspRename(oldSym, newSym, kind, expectedFilePath) {
    console.log(`[doLspRename] Attempting to rename ${vscode.SymbolKind[kind]} '${oldSym}' to '${newSym}'`);
    // 1) Find all workspace symbols matching oldSym
    const symbols = (await vscode.commands.executeCommand("vscode.executeWorkspaceSymbolProvider", oldSym)) ?? [];
    console.log(`[doLspRename] Found ${symbols.length} symbols for '${oldSym}'`);
    for (const si of symbols) {
        console.log(`[doLspRename] Candidate: name='${si.name}', kind=${vscode.SymbolKind[si.kind]}, file=${si.location.uri.fsPath}`);
    }
    // 2) Filter by kind + optional expectedFilePath
    const normalizedExpectedPath = expectedFilePath
        ?.replace(/\\/g, "/")
        .toLowerCase();
    const filtered = symbols.filter(si => si.kind === kind &&
        (!normalizedExpectedPath ||
            si.location.uri.fsPath.replace(/\\/g, "/").toLowerCase() ===
                normalizedExpectedPath));
    if (filtered.length === 0) {
        throw new Error(`${vscode.SymbolKind[kind]} symbol '${oldSym}' not found${expectedFilePath ? ` in file '${expectedFilePath}'` : ""}.`);
    }
    const match = filtered[0];
    console.log(`[doLspRename] Matched ${vscode.SymbolKind[kind]}: '${match.name}' in '${match.location.uri.fsPath}'`);
    // 3) Invoke the DocumentRenameProvider and get a WorkspaceEdit
    let workspaceEdit;
    try {
        workspaceEdit = await vscode.commands.executeCommand("vscode.executeDocumentRenameProvider", match.location.uri, match.location.range.start, newSym);
    }
    catch (e) {
        console.error(`[doLspRename] Rename command failed: ${e instanceof Error ? e.message : String(e)}`);
        throw e;
    }
    if (!workspaceEdit) {
        console.warn("[doLspRename] No edits returned from rename provider.");
        return [];
    }
    // 4) Apply the WorkspaceEdit
    const applied = await vscode.workspace.applyEdit(workspaceEdit);
    if (!applied) {
        console.error("[doLspRename] Failed to apply rename edit.");
        return [];
    }
    console.log("[doLspRename] Rename applied successfully.");
    // 5) Collect all distinct URIs that the WorkspaceEdit touched
    const editedUris = [];
    for (const [fileUri, _edits] of workspaceEdit.entries()) {
        // fileUri is already a vscode.Uri, so just push it
        editedUris.push(fileUri);
    }
    return editedUris;
}
/**
 * Given a set of file system paths (fsPaths) that were edited,
 * ensure each one is saved. Logs every save action.
 * If a document is already open and dirty, saves it in its existing tab.
 * If it’s not open, opens it in the background (no visible editor) and saves if dirty.
 */
async function saveEditedFiles(editedFilePaths) {
    for (const fsPath of editedFilePaths) {
        try {
            // 1) Check if this file is already open in any TextDocument
            const alreadyOpen = vscode.workspace.textDocuments.find((doc) => doc.uri.fsPath === fsPath);
            if (alreadyOpen) {
                if (alreadyOpen.isDirty) {
                    console.log(`[saveEditedFiles] Saving (open) '${fsPath}'`);
                    await alreadyOpen.save();
                }
                else {
                    console.log(`[saveEditedFiles] Already open but not dirty: '${fsPath}'`);
                }
            }
            else {
                // 2) Not open: open in background (no UI) and then save if dirty
                console.log(`[saveEditedFiles] Opening in background: '${fsPath}'`);
                const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fsPath));
                if (doc.isDirty) {
                    console.log(`[saveEditedFiles] Saving (background) '${fsPath}'`);
                    await doc.save();
                }
                else {
                    console.log(`[saveEditedFiles] Opened in background but not dirty: '${fsPath}'`);
                }
                // We do not call showTextDocument, so no tab actually pops up.
            }
        }
        catch (err) {
            console.warn(`[saveEditedFiles] Could not save '${fsPath}': ${err instanceof Error ? err.message : String(err)}`);
            // Continue with the rest even if one file fails
        }
    }
}
//# sourceMappingURL=extension.js.map