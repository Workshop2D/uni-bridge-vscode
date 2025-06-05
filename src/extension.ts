import * as vscode from "vscode";
import * as net from "net";
import * as fs from "fs";
import * as path from "path";

// us 39218, unity 39217

// --- Interfaces ---
interface HandshakeRequest {
  action: "handshake";
  requestId?: string;
  unityPort: number;          // Port Unity listens on for responses
  projectRoot: string;
}

// Inline rename fields for each batch entry
interface RenameEntry {
  oldNamespace?: string;
  newNamespace?: string;
  oldClass?: string;
  newClass?: string;
  oldFile?: string;          // Original file path (if file is being moved/renamed)
  newFile?: string;          // New file path
}

interface BatchRenameRequest {
  action: "batchRename";
  requestId?: string;
  projectRoot: string;
  requests: RenameEntry[];  // Always an array, even for single
}

type ScriptEditRequest = HandshakeRequest | BatchRenameRequest;

interface UnityResponse {
  requestId?: string;
  status: "ok" | "error";
  message?: string;
  projectRoot?: string;
}

enum RenameSymbolKind {
  Class = 5,
  Namespace = 3,
}

// --- Module-level state ---
let server: net.Server | null = null;
let listeningPort: number | null = null;
let lastSeenUnityIP: string | null = null;
let unityPort: number | null = null;   // port provided by Unity during handshake

export function activate(context: vscode.ExtensionContext) {
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

  function normalizePath(p: string): string {
    if (!p) { return p; }
    let np = p.replace(/\\/g, "/");
    if (np.endsWith("/")) {
      np = np.slice(0, -1);
    }
    return process.platform === "win32" ? np.toLowerCase() : np;
  }

  function sendUnityResponse(resp: UnityResponse) {  
    if (!lastSeenUnityIP || unityPort === null) {
      if (!lastSeenUnityIP && unityPort === null) {
        console.warn("[scriptEdit] Cannot send UnityResponse: missing IP and port");
      } else if (!lastSeenUnityIP) {
        console.warn("[scriptEdit] Cannot send UnityResponse: missing IP");
      } else {
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

  async function handleRequest(socket: net.Socket, generic: any) {
    // Wrap entire logic to catch unexpected errors
    try {
      // Check action field
      if (!generic || typeof generic.action !== "string") {
        const resp: UnityResponse = { status: "error", message: "Missing or invalid action field" };
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
          const resp: UnityResponse = { status: "error", message: msg, requestId };
          sendUnityResponse(resp);
          return;
        }
        if (typeof generic.unityPort !== "number") {
          const msg = "Missing or invalid unityPort for handshake";
          console.warn(`[scriptEdit] ${msg}`);
          const resp: UnityResponse = { status: "error", message: msg, requestId };
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
          const resp: UnityResponse = { status: "error", message: msg, requestId };
          sendUnityResponse(resp);
          return;
        }
        // Handle handshake success
        lastSeenUnityIP = socket.remoteAddress ?? null;
        unityPort = generic.unityPort;
        console.log(`[scriptEdit] Handshake from ${lastSeenUnityIP}:${unityPort}`);

        // Build the response JSON:
        const respObj: UnityResponse = {
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
          const resp: UnityResponse = { status: "error", message: msg, requestId };
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
          const resp: UnityResponse = { status: "error", message: msg, requestId };
          sendUnityResponse(resp);
          return;
        }
        if (!Array.isArray(generic.requests) || generic.requests.length === 0) {
          const msg = "BatchRename request must include a non-empty requests array";
          console.warn(`[scriptEdit] ${msg}`);
          const resp: UnityResponse = { status: "error", message: msg, requestId };
          sendUnityResponse(resp);
          return;
        }

        // Perform all renames
        // Collect file rename operations for later
        const editedFilesSet = new Set<string>();
        const fileRenameQueue: { oldFile: string, newFile: string }[] = [];
        
        // Perform all symbol renames (namespace/class) first
        for (let idx = 0; idx < generic.requests.length; idx++) {
          const req: RenameEntry = generic.requests[idx];

          if (!req.oldNamespace && !req.newNamespace && !req.oldClass && !req.newClass && !req.newFile) {
            const msg = `Rename entry at index ${idx} has no valid rename fields`;
            console.warn(`[scriptEdit] ${msg}`);
            const resp: UnityResponse = { status: "error", message: msg, requestId };
            sendUnityResponse(resp);
            return;
          }

          // Namespace rename
          if (req.oldNamespace && req.newNamespace) {
            try {
              await doLspRename(req.oldNamespace, req.newNamespace, vscode.SymbolKind.Namespace, req.oldFile);
            } catch (e) {
              const msg = `Namespace rename failed for '${req.oldNamespace}' -> '${req.newNamespace}': ${e instanceof Error ? e.message : String(e)}`;
              console.error(`[scriptEdit] ${msg}`);
              const resp: UnityResponse = { status: "error", message: msg, requestId };
              sendUnityResponse(resp);
              return;
            }
          }

          // Class rename
          if (req.oldClass && req.newClass) {
            try {
              await doLspRename(req.oldClass, req.newClass, vscode.SymbolKind.Class, req.oldFile);
            } catch (e) {
              const msg = `Class rename failed for '${req.oldClass}' -> '${req.newClass}': ${e instanceof Error ? e.message : String(e)}`;
              console.error(`[scriptEdit] ${msg}`);
              const resp: UnityResponse = { status: "error", message: msg, requestId };
              sendUnityResponse(resp);
              return;
            }
          }

          // Collect file rename to do later
          if (req.oldFile && req.newFile) {
            fileRenameQueue.push({ oldFile: req.oldFile, newFile: req.newFile });
          } else if (req.newFile) {
            // Only newFile provided: open it directly
            try {
              const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(req.newFile));
              await vscode.window.showTextDocument(doc);
            } catch (openErr) {
              const msg = `Open file failed for '${req.newFile}': ${openErr instanceof Error ? openErr.message : String(openErr)}`;
              console.warn(`[scriptEdit] ${msg}`);
              const resp: UnityResponse = { status: "error", message: msg, requestId };
              sendUnityResponse(resp);
              return;
            }
          }
        }

        // After all class/namespace renames, perform file renames
        for (const { oldFile, newFile } of fileRenameQueue) {
          const oldUri = vscode.Uri.file(oldFile);
          const newUri = vscode.Uri.file(newFile);
          try {
            await vscode.workspace.fs.rename(oldUri, newUri);
            console.log(`[scriptEdit] File renamed from '${oldFile}' to '${newFile}'`);
          } catch (fsErr) {
            const msg = `File rename error for '${oldFile}' -> '${newFile}': ${fsErr instanceof Error ? fsErr.message : String(fsErr)}`;
            console.error(`[scriptEdit] ${msg}`);
            const resp: UnityResponse = { status: "error", message: msg, requestId };
            sendUnityResponse(resp);
            return;
          }

          try {
            const doc = await vscode.workspace.openTextDocument(newUri);
            await vscode.window.showTextDocument(doc);
          } catch (openErr) {
            console.warn(`[scriptEdit] Open file failed for '${newFile}': ${openErr}`);
            // Not fatal
          }
        }

        // All entries succeeded
        const resp: UnityResponse = { status: "ok", requestId };
        sendUnityResponse(resp);

        return;
      }

      // Unknown action
      const msg = `Unknown action '${generic.action}'`;
      console.warn(`[scriptEdit] ${msg}`);
      const resp: UnityResponse = { status: "error", message: msg, requestId };
      sendUnityResponse(resp);
    } catch (err) {
      const msg = `Unexpected error: ${err instanceof Error ? err.message : String(err)}`;
      console.error(`[scriptEdit] ${msg}`);
      const resp: UnityResponse = { status: "error", message: msg, requestId: (generic && generic.requestId) };
      sendUnityResponse(resp);
    }
  }

  function onSocket(socket: net.Socket) {
    console.log("[scriptEdit] New client connection from", socket.remoteAddress);
    let dataBuffer = "";

    socket.on("data", (chunk) => {
      dataBuffer += chunk.toString();
      let newlineIndex: number;
      while ((newlineIndex = dataBuffer.indexOf("\n")) !== -1) {
        const message = dataBuffer.slice(0, newlineIndex);
        dataBuffer = dataBuffer.slice(newlineIndex + 1);
        console.log("[scriptEdit] Raw incoming message:", message);
        let parsed: ScriptEditRequest;
        try {
          parsed = JSON.parse(message) as ScriptEditRequest;
        } catch (e) {
          const msg = `[scriptEdit] JSON parse error: ${e}`;
          console.error(msg);
          const resp: UnityResponse = { status: "error", message: msg };
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
      } catch (err: any) {
        if (err.code !== "EADDRINUSE" && err.code !== "EACCES") {
          vscode.window.showErrorMessage(`scriptEdit: failed to bind TCP port: ${err.message}`);
          return;
        }
      }
    }
    vscode.window.showErrorMessage("scriptEdit: could not bind any TCP port in range 39218–39318. Extension will not run.");
  })();
}

async function doLspRename(
  oldSym: string,
  newSym: string,
  kind: vscode.SymbolKind,
  expectedFilePath?: string
) : Promise<vscode.Uri[]> {
  console.log(`[doLspRename] Attempting to rename ${vscode.SymbolKind[kind]} '${oldSym}' to '${newSym}'`);

  const symbols = (await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
    "vscode.executeWorkspaceSymbolProvider",
    oldSym
  )) ?? [];

  console.log(`[doLspRename] Found ${symbols.length} symbols for '${oldSym}'`);

  for (const si of symbols) {
    console.log(`[doLspRename] Candidate: name='${si.name}', kind=${vscode.SymbolKind[si.kind]}, file=${si.location.uri.fsPath}`);
  }

  const normalizedExpectedPath = expectedFilePath?.replace(/\\/g, "/").toLowerCase();

  const filtered = symbols.filter(si =>
    si.kind === kind &&
    (!normalizedExpectedPath || si.location.uri.fsPath.replace(/\\/g, "/").toLowerCase() === normalizedExpectedPath)
  );

  if (filtered.length === 0) {
    throw new Error(`${vscode.SymbolKind[kind]} symbol '${oldSym}' not found${expectedFilePath ? ` in file '${expectedFilePath}'` : ''}.`);
  }

  const match = filtered[0];

  console.log(`[doLspRename] Matched ${vscode.SymbolKind[kind]}: '${match.name}' in '${match.location.uri.fsPath}'`);

  try {
  const edit = await vscode.commands.executeCommand<vscode.WorkspaceEdit>(
    'vscode.executeDocumentRenameProvider',
    match.location.uri,
    match.location.range.start,
    newSym
  );


  if (edit) {
    const success = await vscode.workspace.applyEdit(edit);
    if (success) {
      console.log('[doLspRename] Rename applied successfully.');
    } else {
      console.error('[doLspRename] Failed to apply rename edit.');
    }
  } else {
    console.warn('[doLspRename] No edits returned from rename provider.');
  }
} catch (e) {
  console.error(`[doLspRename] Rename command failed: ${e instanceof Error ? e.message : String(e)}`);
  throw e;
}

  // Collect all distinct URIs that were edited
  // workspaceEdit.entries() returns a map from Uri.toString() -> TextEdit[]
  const editedUris: vscode.Uri[] = [];
  for (const [uriString, edits] of Object.entries(workspaceEdit.entries())) {
    // Convert the key (string) back to a Uri
    const fileUri = vscode.Uri.parse(uriString);
    editedUris.push(fileUri);
  }

return editedUris;
}
