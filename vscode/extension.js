const vscode = require("vscode")
const { execSync, spawn } = require("child_process")

let braidfsPath
let statusBarItem
let editingDocuments = new Map()

function activate(context) {
    braidfsPath = findExecutable("braidfs")

    // Create status bar item
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
    context.subscriptions.push(statusBarItem)
    updateStatusBar()

    // Register custom save command
    const customSaveCommand = vscode.commands.registerCommand("myExtension.customSave", async () => {
        const editor = vscode.window.activeTextEditor
        const document = editor?.document
        const filePath = document?.uri.fsPath
        const ver = editingDocuments.get(filePath)

        if (isInHttpDirectory(filePath) && ver) {
            // This is a BraidFS-managed file, handle save with BraidFS
            try {
                await new Promise((resolve, reject) => {
                    const filePath = document.uri.fsPath
                    const process = spawn(braidfsPath, ["edited", filePath, ver], {
                        stdio: ["pipe", "pipe", "pipe"],
                    })

                    process.stdin.write(document.getText())
                    process.stdin.end()

                    let stderr = ""
                    process.stderr.on("data", (data) => {
                        stderr += data.toString()
                    })

                    process.on("close", (code) => {
                        if (code === 0) {
                            resolve()
                        } else {
                            reject(new Error(`BraidFS exited with code ${code}: ${stderr}`))
                        }
                    })
                })

                // Mark as saved by reverting to the version saved by BraidFS
                await vscode.commands.executeCommand("workbench.action.files.revert")
                editingDocuments.delete(filePath)
                updateStatusBar()
            } catch (error) {
                vscode.window.showErrorMessage(`BraidFS save error: ${error.message}`)
            }
        } else {
            // Not a BraidFS-managed file or no version found, use normal save
            await vscode.commands.executeCommand("workbench.action.files.save")
        }
    })
    context.subscriptions.push(customSaveCommand)

    // Track document changes to detect when editing starts/stops
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument((event) => {
            const document = event.document
            const filePath = document.uri.fsPath

            if (isInHttpDirectory(filePath)) {
                if (document.isDirty && !editingDocuments.has(filePath)) {
                    startBraidfsEditing(document)
                } else if (!document.isDirty && editingDocuments.has(filePath)) {
                    editingDocuments.delete(filePath)
                }
                updateStatusBar()
            }
        })
    )

    // Track document close to clean up
    context.subscriptions.push(
        vscode.workspace.onDidCloseTextDocument((document) => {
            editingDocuments.delete(document.uri.fsPath)
            updateStatusBar()
        })
    )

    // Update status bar when active editor changes
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(() => {
            updateStatusBar()
        })
    )
}

function findExecutable(name) {
    try {
        return execSync(`which ${name}`, { encoding: "utf8" }).trim()
    } catch (e) {
        return null
    }
}

function isInHttpDirectory(filePath) {
    const httpDir = require("path").join(require("os").homedir(), "http")
    return filePath && filePath.startsWith(httpDir) && !filePath.includes("#")
}

function startBraidfsEditing(document) {
    const filePath = document.uri.fsPath
    try {
        const result = execSync(`${braidfsPath} editing "${filePath}"`, {
            input: document.getText(),
            encoding: "utf8",
        }).trim()
        editingDocuments.set(filePath, result)
        updateStatusBar()
    } catch (error) {
        vscode.window.showErrorMessage(`BraidFS editing error: ${error.message}`)
    }
}

function updateStatusBar() {
    const path = vscode.window.activeTextEditor?.document.uri.fsPath
    if (isInHttpDirectory(path)) {
        const ver = editingDocuments.get(path)
        if (ver) {
            statusBarItem.text = "$(edit) BraidFS Editing: " + ver
            statusBarItem.show()
            return
        }
    }
    statusBarItem.hide()
}

function deactivate() {
    if (statusBarItem) statusBarItem.dispose()
}

module.exports = {
    activate,
    deactivate,
}
