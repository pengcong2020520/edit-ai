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
const initialRootDirectory = resolve(process.env.NEWTYPE_WEB_ROOT ?? process.cwd())
let workspaceDirectory = initialRootDirectory
const publicDirectory = resolve(import.meta.dir, "public")
const port = Number(process.env.PORT ?? process.env.NEWTYPE_WEB_PORT ?? 3899)

loadDotEnv(initialRootDirectory)

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

function resolveWorkspacePath(inputPath = "."): string {
  const resolved = resolve(workspaceDirectory, inputPath)
  if (!isInsideRoot(resolved)) {
    throw new Error("Path is outside the workspace")
  }
  return resolved
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
  const resolved = resolveWorkspacePath(inputPath)
  const fileStat = await stat(resolved)

  if (fileStat.isFile()) {
    if (extname(resolved) !== ".md") throw new Error("Only Markdown files are supported")
    return {
      path: relative(workspaceDirectory, resolved),
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
    sections.push(`<File path="${relative(workspaceDirectory, file)}">\n${content.trim()}\n</File>`)
  }

  return {
    path: relative(workspaceDirectory, resolved) || ".",
    name: resolved.split("/").pop() || workspaceDirectory,
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
    const relPath = relative(workspaceDirectory, fullPath) || "."
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
  return c.json({ rootDirectory: workspaceDirectory })
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
  }>(c)

  if (!body.message?.trim()) {
    return c.json({ error: "Message is required" }, 400)
  }

  const mode = body.mode ?? "chat"
  const task = runner.create({
    mode,
    message: body.message,
    context: body.context,
    style: body.style,
    filePath: body.filePath,
    conversation: Array.isArray(body.conversation) ? body.conversation : [],
    directory: workspaceDirectory,
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
  const dir = resolveWorkspacePath(dirParam)
  const entries = await readdir(dir, { withFileTypes: true })
  const files = entries
    .filter((entry) => !entry.name.startsWith("."))
    .filter((entry) => !(entry.isDirectory() && ignoredDirectoryNames.has(entry.name)))
    .filter((entry) => entry.isDirectory() || entry.name.endsWith(".md"))
    .map((entry) => {
      const fullPath = join(dir, entry.name)
      return {
        name: entry.name,
        path: relative(workspaceDirectory, fullPath) || ".",
        type: entry.isDirectory() ? "directory" : "markdown",
      }
    })
    .sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name))
  return c.json({ rootDirectory: workspaceDirectory, current: relative(workspaceDirectory, dir) || ".", files })
})

app.get("/api/file", async (c) => {
  const filePath = c.req.query("path")
  if (!filePath) return c.json({ error: "path query is required" }, 400)
  const resolved = resolveWorkspacePath(filePath)
  if (extname(resolved) !== ".md") return c.json({ error: "Only Markdown files are supported" }, 400)
  const fileStat = await stat(resolved)
  if (!fileStat.isFile()) return c.json({ error: "Path is not a file" }, 400)
  const content = await readFile(resolved, "utf-8")
  return c.json({ path: relative(workspaceDirectory, resolved), content })
})

app.get("/api/references", async (c) => {
  const query = (c.req.query("q") ?? "").trim().toLowerCase()
  const entries = await collectReferenceEntries(workspaceDirectory, query)
  return c.json({
    rootDirectory: workspaceDirectory,
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
  const resolved = resolveWorkspacePath(normalizedPath)
  if (extname(resolved) !== ".md") return c.json({ error: "Only Markdown files can be written" }, 400)
  mkdirSync(resolve(resolved, ".."), { recursive: true })
  await writeFile(resolved, body.content, "utf-8")
  return c.json({ path: relative(workspaceDirectory, resolved) })
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
