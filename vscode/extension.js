const vscode = require("vscode")
const { execSync, spawn } = require("child_process")

let braidfsPath
let statusBarItem
let editingDocuments = new Map()

function activate(context) {
    braidfsPath = execSync(`which braidfs`, { encoding: "utf8" }).trim()

    // Create status bar item
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
    context.subscriptions.push(statusBarItem)
    updateStatusBar()

    // Register custom save command
    const customSaveCommand = vscode.commands.registerCommand("myExtension.customSave", async () => {
        const editor = vscode.window.activeTextEditor
        const document = editor?.document
        const filePath = document?.uri.fsPath
        const ver = await editingDocuments.get(filePath)

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
                    var text = document.getText()
                    editingDocuments.set(filePath, new Promise(done => {
                        var process = spawn(braidfsPath, ["editing", filePath],
                            { stdio: ["pipe", "pipe", "pipe"] })
                        let stdout = []
                        process.stdout.on("data", x => stdout.push(x))
                        process.on("close", () => {
                            done(Buffer.concat(stdout).toString())
                            updateStatusBar()
                        })
                        process.stdin.write(text)
                        process.stdin.end()
                    }))
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

function isInHttpDirectory(filePath) {
    var httpDir = require("path").join(require("os").homedir(), "http")
    return filePath && filePath.startsWith(httpDir) && !filePath.includes("#")
}

async function updateStatusBar() {
    var path = vscode.window.activeTextEditor?.document.uri.fsPath
    if (isInHttpDirectory(path)) {
        var ver = await Promise.race([editingDocuments.get(path), 'waiting..'])
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
