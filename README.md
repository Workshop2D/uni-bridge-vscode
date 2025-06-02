# UniBridge

TCP Bridge between Unity and VS Code for seamless two-way communication and integration.

---

## Overview

**UniBridge** enables smooth communication between Unity (the game engine) and Visual Studio Code (the editor) via TCP sockets. This bridge allows Unity to send rename and file update requests to VS Code, which processes these requests using its workspace and Language Server Protocol (LSP) capabilities, and then responds back to Unity with success or error information.

This integration facilitates:

- Automated refactoring commands (rename namespaces, classes, files)

---

## Features

- Send rename requests from Unity to VS Code over TCP
- VS Code processes rename requests using workspace symbol providers and rename providers
- VS Code opens and shows updated files on rename
- Sends back success or error responses to Unity
- Handles batch rename requests sequentially
- Supports project root validation for consistency
- Uses newline-delimited JSON messages for reliable TCP communication

---

## Usage

### Extension Side

- Currently implemented:

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

### Unity Side

Unity Side is handled by Unity Assets Store asset: UniBridge "<link>"

- Use the provided `UniBridgeClient` static class in Unity to send rename requests.
- Configure host and port (default: `127.0.0.1:39217`) to match your VS Code extension settings.
- Handle responses
- Example rename request:

```csharp
var options = new RenameOptions {
    OldNamespace = "OldNamespace",
    NewNamespace = "NewNamespace",
    OldClass = "OldClassName",
    NewClass = "NewClassName",
    OldFilePath = "Assets/Scripts/OldClassName.cs",
    NewFilePath = "Assets/Scripts/NewClassName.cs"
};

UniBridgeClient.SendRenameRequest(options);
