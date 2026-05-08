#!/usr/bin/env bun
import { existsSync, mkdirSync } from "node:fs"
import { readdir, readFile, stat, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path"
import { Hono } from "hono"
import { WebTaskRunner } from "./task-runner"
import type { ContentMode, ConversationTurn } from "./task-prompts"
import { loadDotEnv, readSettings, toPublicSettings, writeSettings, type WebSettings } from "./settings"

const app = new Hono()
const runner = new WebTaskRunner()
loadDotEnv(process.cwd())

const initialRootDirectory = resolve(process.env.EDITAI_WEB_ROOT ?? process.env.NEWTYPE_WEB_ROOT ?? process.cwd())
let workspaceDirectory = initialRootDirectory
const publicDirectory = resolve(import.meta.dir, "public")
const port = Number(process.env.PORT ?? process.env.EDITAI_WEB_PORT ?? process.env.NEWTYPE_WEB_PORT ?? 3899)
const NOTE_DIRECTORY_NAME = "editai_note"
const EDITAI_DIRECTORY_NAME = ".editai"

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
}

const ignoredDirectoryNames = new Set(["node_modules", "dist", ".git"])
const MAX_REFERENCE_FILES = 60
const MAX_REFERENCE_BYTES = 220_000

function isInsideRoot(path: string): boolean {
  const rel = relative(workspaceDirectory, path)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

function getNotesDirectory(): string {
  const notesDirectory = join(workspaceDirectory, NOTE_DIRECTORY_NAME)
  mkdirSync(notesDirectory, { recursive: true })
  return notesDirectory
}

function getEditaiDirectory(): string {
  const directory = join(workspaceDirectory, EDITAI_DIRECTORY_NAME)
  mkdirSync(directory, { recursive: true })
  return directory
}

function getStyleFingerprintPath(): string {
  return join(getEditaiDirectory(), "style-fingerprint.md")
}

function getStyleStatusPath(): string {
  return join(getEditaiDirectory(), "style-status.json")
}

function isInsideNotes(path: string): boolean {
  const notesDirectory = getNotesDirectory()
  const rel = relative(notesDirectory, path)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

function resolveWorkspacePath(inputPath = "."): string {
  const resolved = resolve(workspaceDirectory, inputPath)
  if (!isInsideRoot(resolved)) {
    throw new Error("Path is outside the workspace")
  }
  return resolved
}

function resolveNotesPath(inputPath = "."): string {
  const resolved = resolve(getNotesDirectory(), inputPath)
  if (!isInsideNotes(resolved)) {
    throw new Error("Path is outside editai_note")
  }
  return resolved
}

function validateProjectName(name: string): string | undefined {
  const trimmed = name.trim()
  if (!trimmed) return "Project name is required"
  if (trimmed === "." || trimmed === "..") return "Project name cannot be . or .."
  if (/[/:\\]/.test(trimmed)) return "Project name cannot contain /, :, or \\"
  if (/[\x00-\x1f]/.test(trimmed)) return "Project name contains unsupported characters"
  return undefined
}

function normalizeDirectoryInput(input: string): string {
  const trimmed = input.trim().replace(/^["']|["']$/g, "")
  if (trimmed === "~") return homedir()
  if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2))
  return trimmed
}

async function readJson<T>(c: { req: { json: () => Promise<T> } }): Promise<T> {
  return await c.req.json()
}

async function collectMarkdownFiles(directory: string, files: string[] = []): Promise<string[]> {
  if (files.length >= MAX_REFERENCE_FILES) return files
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    if (files.length >= MAX_REFERENCE_FILES) break
    if (entry.name.startsWith(".")) continue
    const fullPath = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (ignoredDirectoryNames.has(entry.name)) continue
      await collectMarkdownFiles(fullPath, files)
      continue
    }
    if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(fullPath)
    }
  }
  return files
}

async function readReference(inputPath: string): Promise<{
  path: string
  name: string
  type: "markdown" | "directory"
  content: string
  fileCount?: number
}> {
  const resolved = resolveNotesPath(inputPath)
  const fileStat = await stat(resolved)

  if (fileStat.isFile()) {
    if (extname(resolved) !== ".md") throw new Error("Only Markdown files are supported")
    return {
      path: relative(getNotesDirectory(), resolved),
      name: resolved.split("/").pop() ?? "Markdown",
      type: "markdown",
      content: await readFile(resolved, "utf-8"),
    }
  }

  if (!fileStat.isDirectory()) throw new Error("Path is not a file or directory")

  const markdownFiles = await collectMarkdownFiles(resolved)
  let totalBytes = 0
  const sections: string[] = []
  for (const file of markdownFiles) {
    const content = await readFile(file, "utf-8")
    const nextBytes = new TextEncoder().encode(content).byteLength
    if (totalBytes + nextBytes > MAX_REFERENCE_BYTES) {
      sections.push(`\n[目录内容已截断，超过 ${Math.round(MAX_REFERENCE_BYTES / 1000)}KB 上下文限制。]`)
      break
    }
    totalBytes += nextBytes
    sections.push(`<File path="${relative(getNotesDirectory(), file)}">\n${content.trim()}\n</File>`)
  }

  return {
    path: relative(getNotesDirectory(), resolved) || ".",
    name: resolved.split("/").pop() || getNotesDirectory(),
    type: "directory",
    content: sections.join("\n\n"),
    fileCount: markdownFiles.length,
  }
}

async function collectReferenceEntries(directory: string, query: string, entries: Array<{
  name: string
  path: string
  type: "directory" | "markdown"
}> = []): Promise<typeof entries> {
  if (entries.length >= 120) return entries
  const children = await readdir(directory, { withFileTypes: true })
  for (const child of children) {
    if (entries.length >= 120) break
    if (child.name.startsWith(".")) continue
    const fullPath = join(directory, child.name)
    const relPath = relative(getNotesDirectory(), fullPath) || "."
    if (child.isDirectory()) {
      if (ignoredDirectoryNames.has(child.name)) continue
      if (!query || child.name.toLowerCase().includes(query) || relPath.toLowerCase().includes(query)) {
        entries.push({ name: child.name, path: relPath, type: "directory" })
      }
      await collectReferenceEntries(fullPath, query, entries)
      continue
    }
    if (child.isFile() && child.name.endsWith(".md")) {
      if (!query || child.name.toLowerCase().includes(query) || relPath.toLowerCase().includes(query)) {
        entries.push({ name: child.name, path: relPath, type: "markdown" })
      }
    }
  }
  return entries
}

app.get("/api/health", (c) => {
  return c.json({
    ok: true,
    rootDirectory: workspaceDirectory,
    notesDirectory: getNotesDirectory(),
    settingsPath: join(initialRootDirectory, ".newtype", "web-settings.json"),
  })
})

app.get("/api/settings", (c) => {
  const settings = readSettings(initialRootDirectory)
  return c.json(toPublicSettings(initialRootDirectory, settings))
})

app.put("/api/settings", async (c) => {
  const body = await readJson<Partial<WebSettings>>(c)
  const existing = readSettings(initialRootDirectory)
  const merged: WebSettings = {
    providers: {
      ...existing.providers,
      ...Object.fromEntries(
        Object.entries(body.providers ?? {}).filter(([, value]) => typeof value === "string" && value.length > 0)
      ),
    },
    defaultModel: body.defaultModel ?? existing.defaultModel,
    agentModels: {
      ...existing.agentModels,
      ...(body.agentModels ?? {}),
    },
  }
  writeSettings(initialRootDirectory, merged)
  return c.json(toPublicSettings(initialRootDirectory, merged))
})

app.get("/api/workspace", (c) => {
  return c.json({
    rootDirectory: workspaceDirectory,
    notesDirectory: getNotesDirectory(),
    initialRootDirectory,
  })
})

app.put("/api/workspace", async (c) => {
  const body = await readJson<{ path?: string }>(c)
  if (!body.path?.trim()) {
    return c.json({ error: "path is required" }, 400)
  }

  const nextPath = resolve(normalizeDirectoryInput(body.path))
  if (!existsSync(nextPath)) {
    return c.json({ error: "Directory does not exist" }, 400)
  }

  const nextStat = await stat(nextPath)
  if (!nextStat.isDirectory()) {
    return c.json({ error: "Path is not a directory" }, 400)
  }

  workspaceDirectory = nextPath
  return c.json({ rootDirectory: workspaceDirectory, notesDirectory: getNotesDirectory() })
})

app.get("/api/style-fingerprint", async (c) => {
  const fingerprintPath = getStyleFingerprintPath()
  const statusPath = getStyleStatusPath()
  let skipped = false
  if (existsSync(statusPath)) {
    try {
      const parsed = JSON.parse(await readFile(statusPath, "utf-8")) as { skipped?: boolean }
      skipped = Boolean(parsed.skipped)
    } catch {
      skipped = false
    }
  }
  const content = existsSync(fingerprintPath) ? await readFile(fingerprintPath, "utf-8") : ""
  return c.json({
    configured: Boolean(content.trim()),
    skipped,
    content,
    path: relative(workspaceDirectory, fingerprintPath),
  })
})

app.put("/api/style-fingerprint", async (c) => {
  const body = await readJson<{ content?: string; skipped?: boolean }>(c)
  if (body.skipped) {
    await writeFile(getStyleStatusPath(), JSON.stringify({ skipped: true, updatedAt: new Date().toISOString() }, null, 2) + "\n")
    return c.json({ configured: false, skipped: true })
  }
  if (!body.content?.trim()) return c.json({ error: "content is required" }, 400)
  await writeFile(getStyleFingerprintPath(), body.content.trim() + "\n", "utf-8")
  await writeFile(getStyleStatusPath(), JSON.stringify({ skipped: false, updatedAt: new Date().toISOString() }, null, 2) + "\n")
  return c.json({ configured: true, skipped: false, path: relative(workspaceDirectory, getStyleFingerprintPath()) })
})

app.get("/api/projects", async (c) => {
  const notesDirectory = getNotesDirectory()
  const entries = await readdir(notesDirectory, { withFileTypes: true })
  const projects = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue
    const draftPath = join(notesDirectory, entry.name, "draft.md")
    projects.push({
      name: entry.name,
      path: entry.name,
      draftPath: join(entry.name, "draft.md"),
      hasDraft: existsSync(draftPath),
    })
  }
  return c.json({
    rootDirectory: workspaceDirectory,
    notesDirectory,
    projects: projects.sort((a, b) => a.name.localeCompare(b.name)),
  })
})

app.post("/api/projects", async (c) => {
  const body = await readJson<{ name?: string; initialContent?: string }>(c)
  const name = body.name?.trim() ?? ""
  const validationError = validateProjectName(name)
  if (validationError) return c.json({ error: validationError }, 400)

  const projectDirectory = resolveNotesPath(name)
  if (existsSync(projectDirectory)) return c.json({ error: "Project already exists" }, 409)

  mkdirSync(projectDirectory, { recursive: true })
  const draftPath = join(projectDirectory, "draft.md")
  const initialContent = body.initialContent?.trim()
  await writeFile(draftPath, initialContent ? `${initialContent}\n` : `# ${name}\n\n`, "utf-8")

  return c.json({
    project: {
      name,
      path: name,
      draftPath: join(name, "draft.md"),
    },
  }, 201)
})

app.get("/api/directories", async (c) => {
  const requested = c.req.query("path")
  const dirPath = requested
    ? resolve(normalizeDirectoryInput(requested))
    : workspaceDirectory

  if (!existsSync(dirPath)) {
    return c.json({ error: "Directory does not exist" }, 400)
  }

  const dirStat = await stat(dirPath)
  if (!dirStat.isDirectory()) {
    return c.json({ error: "Path is not a directory" }, 400)
  }

  const entries = await readdir(dirPath, { withFileTypes: true })
  const directories = entries
    .filter((entry) => entry.isDirectory())
    .filter((entry) => !entry.name.startsWith("."))
    .filter((entry) => !ignoredDirectoryNames.has(entry.name))
    .map((entry) => ({
      name: entry.name,
      path: join(dirPath, entry.name),
    }))
    .sort((a, b) => a.name.localeCompare(b.name))

  return c.json({
    current: dirPath,
    parent: dirname(dirPath),
    home: homedir(),
    workspace: workspaceDirectory,
    directories,
  })
})

app.get("/api/tasks", (c) => c.json({ tasks: runner.list() }))

app.get("/api/tasks/:id", (c) => {
  const task = runner.get(c.req.param("id"))
  if (!task) return c.json({ error: "Task not found" }, 404)
  return c.json({ task })
})

app.post("/api/tasks", async (c) => {
  const body = await readJson<{
    mode?: ContentMode
    message?: string
    context?: string
    style?: string
    filePath?: string
    conversation?: ConversationTurn[]
    projectPath?: string
  }>(c)

  if (!body.message?.trim()) {
    return c.json({ error: "Message is required" }, 400)
  }

  const mode = body.mode ?? "chat"
  const taskDirectory = body.projectPath ? resolveNotesPath(body.projectPath) : getNotesDirectory()
  const taskStat = await stat(taskDirectory)
  if (!taskStat.isDirectory()) return c.json({ error: "Project path is not a directory" }, 400)
  const task = runner.create({
    mode,
    message: body.message,
    context: body.context,
    style: body.style,
    filePath: body.filePath,
    conversation: Array.isArray(body.conversation) ? body.conversation : [],
    directory: taskDirectory,
  })
  return c.json({ task }, 201)
})

app.post("/api/tasks/:id/approve", async (c) => {
  const body = await readJson<{ outline?: string }>(c)
  if (!body.outline?.trim()) {
    return c.json({ error: "Outline is required" }, 400)
  }
  const task = await runner.approve(c.req.param("id"), body.outline)
  if (!task) return c.json({ error: "Task not found or not awaiting approval" }, 404)
  return c.json({ task })
})

app.get("/api/files", async (c) => {
  const dirParam = c.req.query("dir") ?? "."
  const dir = resolveNotesPath(dirParam)
  const entries = await readdir(dir, { withFileTypes: true })
  const files = entries
    .filter((entry) => !entry.name.startsWith("."))
    .filter((entry) => !(entry.isDirectory() && ignoredDirectoryNames.has(entry.name)))
    .filter((entry) => entry.isDirectory() || entry.name.endsWith(".md"))
    .map((entry) => {
      const fullPath = join(dir, entry.name)
      return {
        name: entry.name,
        path: relative(getNotesDirectory(), fullPath) || ".",
        type: entry.isDirectory() ? "directory" : "markdown",
      }
    })
    .sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name))
  return c.json({
    rootDirectory: workspaceDirectory,
    notesDirectory: getNotesDirectory(),
    current: relative(getNotesDirectory(), dir) || ".",
    files,
  })
})

app.get("/api/file", async (c) => {
  const filePath = c.req.query("path")
  if (!filePath) return c.json({ error: "path query is required" }, 400)
  const resolved = resolveNotesPath(filePath)
  if (extname(resolved) !== ".md") return c.json({ error: "Only Markdown files are supported" }, 400)
  const fileStat = await stat(resolved)
  if (!fileStat.isFile()) return c.json({ error: "Path is not a file" }, 400)
  const content = await readFile(resolved, "utf-8")
  return c.json({ path: relative(getNotesDirectory(), resolved), content })
})

app.get("/api/references", async (c) => {
  const query = (c.req.query("q") ?? "").trim().toLowerCase()
  const entries = await collectReferenceEntries(getNotesDirectory(), query)
  return c.json({
    rootDirectory: workspaceDirectory,
    notesDirectory: getNotesDirectory(),
    references: entries
      .sort((a, b) => a.type.localeCompare(b.type) || a.path.localeCompare(b.path))
      .slice(0, 80),
  })
})

app.get("/api/reference", async (c) => {
  const referencePath = c.req.query("path")
  if (!referencePath) return c.json({ error: "path query is required" }, 400)
  try {
    return c.json(await readReference(referencePath))
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 400)
  }
})

app.post("/api/files", async (c) => {
  const body = await readJson<{ path?: string; content?: string }>(c)
  if (!body.path?.trim()) return c.json({ error: "path is required" }, 400)
  if (body.content === undefined) return c.json({ error: "content is required" }, 400)

  const normalizedPath = body.path.endsWith(".md") ? body.path : `${body.path}.md`
  const resolved = resolveNotesPath(normalizedPath)
  if (extname(resolved) !== ".md") return c.json({ error: "Only Markdown files can be written" }, 400)
  mkdirSync(resolve(resolved, ".."), { recursive: true })
  await writeFile(resolved, body.content, "utf-8")
  return c.json({ path: relative(getNotesDirectory(), resolved) })
})

app.get("*", async (c) => {
  const requestPath = new URL(c.req.url).pathname
  const normalized = requestPath === "/" ? "/index.html" : requestPath
  const filePath = resolve(publicDirectory, `.${normalized}`)
  const rel = relative(publicDirectory, filePath)

  if (rel.startsWith("..") || !existsSync(filePath)) {
    const indexPath = join(publicDirectory, "index.html")
    return new Response(Bun.file(indexPath), {
      headers: { "content-type": "text/html; charset=utf-8" },
    })
  }

  return new Response(Bun.file(filePath), {
    headers: { "content-type": contentTypes[extname(filePath)] ?? "application/octet-stream" },
  })
})

console.log(`editAI running at http://localhost:${port}`)
console.log(`Workspace: ${workspaceDirectory}`)

Bun.serve({
  port,
  fetch: app.fetch,
})
