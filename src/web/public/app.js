const state = {
  mode: "chat",
  currentTaskId: null,
  pollTimer: null,
  attachments: [],
  renderedTerminalTasks: new Set(),
  workspaceRoot: "",
  expandedDirs: new Set(["."]),
  directoryPickerPath: "",
  messages: [],
  mention: {
    open: false,
    query: "",
    start: -1,
    items: [],
    activeIndex: 0,
  },
}

const modeCopy = {
  chat: { label: "主编", hint: "自由对话，Chief 会判断该调用哪种创作能力。", agents: ["Chief"] },
  research: { label: "调研", hint: "搜索外部信息、整理来源、发现趋势和内容角度。", agents: ["Researcher", "Fact-checker"] },
  write: { label: "写作", hint: "基于主题或素材生成 Markdown 草稿。", agents: ["Writer"] },
  edit: { label: "编辑", hint: "做结构、段落、句子和措辞层面的精修。", agents: ["Editor"] },
  "fact-check": { label: "核查", hint: "逐条验证事实声明、来源和可信度。", agents: ["Fact-checker"] },
  analyze: { label: "分析", hint: "用结构化框架拆解问题，输出判断和建议。", agents: ["Chief", "Researcher"] },
  extract: { label: "提取", hint: "从 Markdown 或文本素材中提取干净结构化内容。", agents: ["Extractor"] },
  archive: { label: "归档", hint: "检索、存储和组织本地知识库资料。", agents: ["Archivist"] },
  pipeline: { label: "全流程", hint: "按调研、分析、写作、核查、编辑完整生产内容。", agents: ["Researcher", "Writer", "Editor", "Fact-checker"] },
}

const $ = (selector) => document.querySelector(selector)
const conversation = $("#conversation")
const composerDropzone = $("#composerDropzone")
const attachmentTray = $("#attachmentTray")
const guidancePanel = $("#guidancePanel")
const appShell = $(".app-shell")
const mentionMenu = $("#mentionMenu")

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#039;")
}

function normalizeMarkdown(value) {
  const trimmed = value.trim()
  const match = trimmed.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i)
  return match ? match[1].trim() : value
}

function renderInlineMarkdown(value) {
  return escapeHtml(value)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
}

function isTableStart(lines, index) {
  return (
    index + 1 < lines.length &&
    lines[index].includes("|") &&
    /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[index + 1])
  )
}

function splitTableRow(line) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim())
}

function renderTable(lines, startIndex) {
  const header = splitTableRow(lines[startIndex])
  const rows = []
  let index = startIndex + 2

  while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
    rows.push(splitTableRow(lines[index]))
    index++
  }

  const head = `<thead><tr>${header.map((cell) => `<th>${renderInlineMarkdown(cell)}</th>`).join("")}</tr></thead>`
  const body = `<tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${renderInlineMarkdown(cell)}</td>`).join("")}</tr>`).join("")}</tbody>`
  return { html: `<div class="table-wrap"><table>${head}${body}</table></div>`, nextIndex: index }
}

function renderMarkdown(value) {
  const source = normalizeMarkdown(value)
  const blocks = source.split(/(```[\s\S]*?```)/g)

  return blocks.map((block) => {
    if (block.startsWith("```")) {
      const code = block.replace(/^```[a-zA-Z0-9_-]*\n?/, "").replace(/\n?```$/, "")
      return `<pre><code>${escapeHtml(code)}</code></pre>`
    }

    const lines = block.split(/\r?\n/)
    const html = []
    let list = []
    let quote = []

    const flushList = () => {
      if (list.length > 0) {
        html.push(`<ul>${list.map((item) => `<li>${renderInlineMarkdown(item)}</li>`).join("")}</ul>`)
        list = []
      }
    }

    const flushQuote = () => {
      if (quote.length > 0) {
        html.push(`<blockquote>${quote.map((item) => `<p>${renderInlineMarkdown(item)}</p>`).join("")}</blockquote>`)
        quote = []
      }
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const trimmed = line.trim()
      if (!trimmed) {
        flushList()
        flushQuote()
        continue
      }

      if (isTableStart(lines, i)) {
        flushList()
        flushQuote()
        const table = renderTable(lines, i)
        html.push(table.html)
        i = table.nextIndex - 1
        continue
      }

      const heading = trimmed.match(/^(#{1,4})\s+(.+)$/)
      if (heading) {
        flushList()
        flushQuote()
        const level = heading[1].length
        html.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`)
        continue
      }

      const quoteLine = trimmed.match(/^>\s?(.+)$/)
      if (quoteLine) {
        flushList()
        quote.push(quoteLine[1])
        continue
      }

      const bullet = trimmed.match(/^[-*]\s+(.+)$/)
      if (bullet) {
        flushQuote()
        list.push(bullet[1])
        continue
      }

      flushList()
      flushQuote()
      html.push(`<p>${renderInlineMarkdown(trimmed)}</p>`)
    }

    flushList()
    flushQuote()
    return html.join("")
  }).join("")
}

function setMode(mode) {
  state.mode = mode
  document.querySelectorAll(".mode").forEach((button) => {
    button.classList.toggle("active", button.dataset.mode === mode)
  })
  $("#modeHint").textContent = modeCopy[mode]?.hint ?? ""
}

function setStatus(status) {
  $("#taskStatus").textContent = status
}

function setTopAgentActivity(task) {
  const activity = $("#agentActivity")
  const agents = modeCopy[task.mode]?.agents ?? ["Chief"]
  const latestEvent = task.events?.at(-1)
  activity.classList.remove("idle")
  activity.querySelector(".activity-label").textContent = latestEvent?.message || `${task.label} 进行中`
  activity.querySelector(".activity-agents").textContent = agents.join(" / ")
}

function clearTopAgentActivity(label = "待命") {
  const activity = $("#agentActivity")
  activity.classList.add("idle")
  activity.querySelector(".activity-label").textContent = label
  activity.querySelector(".activity-agents").textContent = ""
}

function setManualAgentActivity(label, agents = []) {
  const activity = $("#agentActivity")
  activity.classList.remove("idle")
  activity.querySelector(".activity-label").textContent = label
  activity.querySelector(".activity-agents").textContent = agents.join(" / ")
}

function addMessage(role, body, meta, options = {}) {
  const article = document.createElement("article")
  article.className = `message ${role}`
  article.innerHTML = `
    <div class="message-meta"></div>
    <div class="message-body"></div>
  `
  article.querySelector(".message-meta").textContent = meta ?? (role === "user" ? "You" : "editAI")
  article.querySelector(".message-body").innerHTML = renderMarkdown(body)
  conversation.appendChild(article)
  conversation.scrollTop = conversation.scrollHeight
  if (options.record !== false && (role === "user" || role === "assistant")) {
    state.messages.push({ role, content: body })
    state.messages = state.messages.slice(-16)
  }
  return article
}

function getOutputGuidance(output = "") {
  const source = normalizeMarkdown(output)
    .replace(/```[\s\S]*?```/g, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  const headings = source
    .filter((line) => /^#{1,3}\s+/.test(line))
    .map((line) => line.replace(/^#{1,3}\s+/, ""))
    .slice(0, 5)
  const bullets = source
    .filter((line) => /^[-*]\s+/.test(line) || /^>\s?/.test(line))
    .map((line) => line.replace(/^[-*]\s+/, "").replace(/^>\s?/, ""))
    .slice(0, 5)
  const fallback = source
    .filter((line) => !/^#{1,6}\s+/.test(line) && !line.includes("|"))
    .slice(0, 4)

  return [...headings, ...bullets, ...fallback]
    .map((line) => line.replace(/\*\*/g, "").trim())
    .filter(Boolean)
    .filter((line, index, list) => list.indexOf(line) === index)
    .slice(0, 7)
}

function renderTaskGuidance(task) {
  const events = (task.events ?? []).slice(-5)
  const suggestions = getOutputGuidance(task.output || task.error || "")
  const statusLine = task.status === "awaiting_approval" ? "等待你确认或修改大纲" : `${task.label} · ${task.status}`
  const eventItems = events.length
    ? events.map((event) => `<li><strong>${renderInlineMarkdown(event.type)}</strong>：${renderInlineMarkdown(event.message)}</li>`).join("")
    : "<li>Agent 正在整理判断。</li>"
  const suggestionItems = suggestions.length
    ? suggestions.map((item) => `<li>${renderInlineMarkdown(item)}</li>`).join("")
    : "<li>关键建议会随 agent 输出逐步沉淀。</li>"

  $("#guidanceTitle").textContent = "参考方向"
  $("#guidanceMeta").textContent = statusLine
  guidancePanel.classList.remove("empty")
  guidancePanel.innerHTML = `
    <h3>当前重点</h3>
    <ul>${eventItems}</ul>
    <h3>可参考判断</h3>
    <ul>${suggestionItems}</ul>
  `
}

function resetGuidancePanel() {
  $("#guidanceTitle").textContent = "参考方向"
  $("#guidanceMeta").textContent = "Agent 的关键判断会在这里汇总。"
  guidancePanel.classList.add("empty")
  guidancePanel.textContent = "开始一个创作任务后，这里会沉淀每一步 agent 给出的方向、风险和下一步建议。"
}

function addApprovalMessage(task) {
  const article = document.createElement("article")
  article.className = "message assistant approval-message"
  article.innerHTML = `
    <div class="message-meta">Pipeline approval</div>
    <div class="approval-card">
      <div class="approval-preview approval-editor markdown-render" contenteditable="true" role="textbox" aria-label="修改大纲"></div>
      <div class="approval-actions">
        <span>直接在渲染大纲中修改，确认后继续写作。</span>
        <button class="send-button">Approve</button>
      </div>
    </div>
  `
  const approvalEditor = article.querySelector(".approval-editor")
  approvalEditor.innerHTML = renderMarkdown(task.output || "")
  article.querySelector("button").addEventListener("click", () => {
    const outline = approvalEditor.innerText.trim()
    approvePipeline(task.id, outline)
  })
  conversation.appendChild(article)
  conversation.scrollTop = conversation.scrollHeight
}

function renderTask(task) {
  state.currentTaskId = task.id
  setStatus(task.status)
  renderTaskGuidance(task)

  if (task.status === "running" || task.status === "queued") {
    setTopAgentActivity(task)
    return
  }

  if (task.status === "awaiting_approval") {
    stopPolling()
    setTopAgentActivity(task)
    if (!conversation.querySelector(".approval-message")) {
      addApprovalMessage(task)
    }
    return
  }

  if ((task.status === "completed" || task.status === "failed") && !state.renderedTerminalTasks.has(task.id)) {
    stopPolling()
    state.renderedTerminalTasks.add(task.id)
    clearTopAgentActivity(task.status === "completed" ? "完成" : "失败")
    addMessage("assistant", task.error || task.output || "(No output)", task.label)
  }
}

function buildAttachmentContext() {
  if (state.attachments.length === 0) return ""
  return state.attachments
    .map((file) => {
      const type = file.type === "directory" ? "Directory" : "Attachment"
      const source = file.source ? ` source="${file.source}"` : ""
      return `<${type} name="${file.name}"${source}>\n${file.content}\n</${type}>`
    })
    .join("\n\n")
}

function buildConversationContext() {
  return state.messages
    .filter((message) => message.content.trim())
    .slice(-12)
    .map((message) => ({
      role: message.role,
      content: trimForContext(message.content, 6000),
    }))
}

function trimForContext(value, maxLength) {
  if (value.length <= maxLength) return value
  return `${value.slice(0, maxLength)}\n\n[内容过长，已截断]`
}

async function createTask() {
  const message = $("#promptInput").value.trim()
  if (!message && state.attachments.length === 0) return

  const conversation = buildConversationContext()
  const attachmentNames = state.attachments.map((file) => file.name).join(", ")
  const displayedMessage = attachmentNames ? `${message || "处理附件"}\n\n附件：${attachmentNames}` : message
  addMessage("user", displayedMessage)
  setStatus("queued")
  closeMentionMenu()

  const response = await fetch("/api/tasks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      mode: state.mode,
      message: message || "Process the attached files.",
      context: buildAttachmentContext(),
      conversation,
    }),
  })

  const data = await response.json()
  if (!response.ok) {
    addMessage("assistant", data.error || "Task failed to start")
    setStatus("failed")
    return
  }

  $("#promptInput").value = ""
  clearAttachments()
  renderTask(data.task)
  startPolling(data.task.id)
}

function startPolling(id) {
  stopPolling()
  state.pollTimer = setInterval(async () => {
    const response = await fetch(`/api/tasks/${id}`)
    if (!response.ok) return
    const data = await response.json()
    renderTask(data.task)
  }, 1000)
}

function stopPolling() {
  if (state.pollTimer) {
    clearInterval(state.pollTimer)
    state.pollTimer = null
  }
}

async function approvePipeline(id, outline) {
  setStatus("running")
  setManualAgentActivity("大纲已确认，继续写作", modeCopy.pipeline.agents)
  document.querySelectorAll(".approval-message").forEach((node) => node.remove())
  const response = await fetch(`/api/tasks/${id}/approve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ outline }),
  })
  const data = await response.json()
  if (!response.ok) {
    addMessage("assistant", data.error || "Approval failed")
    return
  }
  renderTask(data.task)
  startPolling(data.task.id)
}

async function loadWorkspace() {
  const response = await fetch("/api/workspace")
  const data = await response.json()
  state.workspaceRoot = data.rootDirectory
  $("#currentPath").textContent = data.rootDirectory
  state.expandedDirs = new Set(["."])
  await renderFileTree()
}

async function switchWorkspace() {
  const path = state.directoryPickerPath.trim()
  if (!path) return
  const response = await fetch("/api/workspace", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path }),
  })
  const data = await response.json()
  if (!response.ok) {
    addMessage("assistant", data.error || "Could not switch workspace")
    return
  }
  state.workspaceRoot = data.rootDirectory
  state.expandedDirs = new Set(["."])
  state.messages = []
  resetGuidancePanel()
  await renderFileTree()
  addMessage("assistant", `Workspace switched to:\n\n\`${data.rootDirectory}\``, "Workspace", { record: false })
  $("#directoryDialog").close()
}

async function fetchFiles(dir = ".") {
  const response = await fetch(`/api/files?dir=${encodeURIComponent(dir)}`)
  return await response.json()
}

async function renderFileTree() {
  const tree = $("#fileTree")
  tree.innerHTML = ""
  const root = await buildTreeNode(".", basenamePath(state.workspaceRoot) || state.workspaceRoot, 0)
  tree.appendChild(root)
  $("#currentPath").textContent = state.workspaceRoot
}

async function buildTreeNode(dir, label, depth) {
  const container = document.createElement("div")
  container.className = "tree-group"
  const expanded = state.expandedDirs.has(dir)
  const row = createTreeRow({ name: label, path: dir, type: "directory", depth, expanded })
  container.appendChild(row)

  if (!expanded) return container

  const data = await fetchFiles(dir)
  for (const file of data.files ?? []) {
    if (file.type === "directory") {
      container.appendChild(await buildTreeNode(file.path, file.name, depth + 1))
    } else {
      container.appendChild(createTreeRow({ ...file, depth: depth + 1 }))
    }
  }

  return container
}

function basenamePath(path) {
  const parts = path.split("/").filter(Boolean)
  return parts[parts.length - 1] || path
}

function createTreeRow(file) {
  const button = document.createElement("button")
  button.className = "tree-item"
  button.style.setProperty("--depth", String(file.depth ?? 0))
  button.innerHTML = `<span class="tree-caret"></span><span class="file-name"></span><span class="file-kind"></span>`
  button.querySelector(".tree-caret").textContent = file.type === "directory" ? (file.expanded ? "▾" : "▸") : ""
  button.querySelector(".file-name").textContent = file.name
  button.querySelector(".file-kind").textContent = file.type === "directory" ? "目录" : "MD"
  button.onclick = async () => {
    if (file.type === "directory") {
      if (state.expandedDirs.has(file.path)) {
        state.expandedDirs.delete(file.path)
      } else {
        state.expandedDirs.add(file.path)
      }
      await renderFileTree()
    } else {
      await attachWorkspaceFile(file.path)
    }
  }
  return button
}

async function openDirectoryChooser(path = state.workspaceRoot) {
  await loadDirectoryChooser(path)
  $("#directoryDialog").showModal()
}

async function loadDirectoryChooser(path) {
  const response = await fetch(`/api/directories?path=${encodeURIComponent(path)}`)
  const data = await response.json()
  if (!response.ok) {
    addMessage("assistant", data.error || "Could not load directories")
    return
  }
  state.directoryPickerPath = data.current
  $("#directoryCurrent").textContent = data.current
  $("#directoryList").innerHTML = ""
  for (const dir of data.directories ?? []) {
    const button = document.createElement("button")
    button.className = "directory-option"
    button.type = "button"
    button.textContent = dir.name
    button.addEventListener("click", () => loadDirectoryChooser(dir.path))
    $("#directoryList").appendChild(button)
  }
  $("#directoryHome").onclick = (event) => {
    event.preventDefault()
    loadDirectoryChooser(data.home)
  }
  $("#directoryUp").onclick = (event) => {
    event.preventDefault()
    loadDirectoryChooser(data.parent)
  }
}

async function attachWorkspaceFile(path) {
  const response = await fetch(`/api/reference?path=${encodeURIComponent(path)}`)
  const data = await response.json()
  if (!response.ok) {
    addMessage("assistant", data.error || "Could not open file")
    return
  }
  addAttachment({
    name: data.name || data.path.split("/").pop(),
    content: data.content,
    source: data.path,
    type: data.type,
    fileCount: data.fileCount,
  })
}

function addAttachment(file) {
  const fileKey = file.source || `${file.name}:${file.content.length}`
  const exists = state.attachments.some((item) => {
    const itemKey = item.source || `${item.name}:${item.content.length}`
    return itemKey === fileKey
  })
  if (exists) return
  state.attachments.push(file)
  renderAttachments()
}

function clearAttachments() {
  state.attachments = []
  renderAttachments()
}

function removeAttachment(index) {
  state.attachments.splice(index, 1)
  renderAttachments()
}

function renderAttachments() {
  attachmentTray.innerHTML = ""
  attachmentTray.classList.toggle("has-attachments", state.attachments.length > 0)
  state.attachments.forEach((file, index) => {
    const chip = document.createElement("button")
    chip.className = "attachment-chip"
    chip.type = "button"
    chip.title = file.source || file.name
    chip.innerHTML = `<span class="file-icon"></span><span></span><b>×</b>`
    chip.children[0].textContent = file.type === "directory" ? "DIR" : "MD"
    chip.children[1].textContent = file.name
    chip.addEventListener("click", () => removeAttachment(index))
    attachmentTray.appendChild(chip)
  })
}

async function handleDroppedFiles(event) {
  event.preventDefault()
  event.stopPropagation()
  conversation.classList.remove("dragging")
  composerDropzone.classList.remove("dragging")

  const itemFiles = [...(event.dataTransfer?.items || [])]
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter(Boolean)
  const files = itemFiles.length ? itemFiles : [...(event.dataTransfer?.files || [])]
  for (const file of files) {
    if (!file.name.endsWith(".md") && !file.type.startsWith("text/")) continue
    const content = await file.text()
    addAttachment({ name: file.name, content, source: `drag-drop:${file.name}:${file.size}:${file.lastModified}`, type: "markdown" })
  }
}

function getMentionTrigger(text, cursor) {
  const beforeCursor = text.slice(0, cursor)
  const match = beforeCursor.match(/(^|\s)@([^\s@]*)$/)
  if (!match) return null
  return {
    start: beforeCursor.length - match[2].length - 1,
    query: match[2],
  }
}

async function updateMentionMenu() {
  const input = $("#promptInput")
  const trigger = getMentionTrigger(input.value, input.selectionStart)
  if (!trigger) {
    closeMentionMenu()
    return
  }

  state.mention.open = true
  state.mention.query = trigger.query
  state.mention.start = trigger.start
  state.mention.activeIndex = 0

  const response = await fetch(`/api/references?q=${encodeURIComponent(trigger.query)}`)
  const data = await response.json()
  if (!response.ok) {
    closeMentionMenu()
    return
  }
  state.mention.items = data.references ?? []
  renderMentionMenu()
}

function renderMentionMenu() {
  mentionMenu.innerHTML = ""
  if (!state.mention.open || state.mention.items.length === 0) {
    mentionMenu.hidden = true
    return
  }

  mentionMenu.hidden = false
  state.mention.items.slice(0, 10).forEach((item, index) => {
    const button = document.createElement("button")
    button.type = "button"
    button.className = "mention-option"
    button.classList.toggle("active", index === state.mention.activeIndex)
    button.innerHTML = `<span class="file-icon"></span><span class="mention-main"><b></b><small></small></span>`
    button.querySelector(".file-icon").textContent = item.type === "directory" ? "DIR" : "MD"
    button.querySelector("b").textContent = item.name
    button.querySelector("small").textContent = item.path
    button.addEventListener("mousedown", (event) => {
      event.preventDefault()
      selectMention(index)
    })
    mentionMenu.appendChild(button)
  })
}

function closeMentionMenu() {
  state.mention.open = false
  state.mention.query = ""
  state.mention.start = -1
  state.mention.items = []
  state.mention.activeIndex = 0
  mentionMenu.hidden = true
  mentionMenu.innerHTML = ""
}

async function selectMention(index = state.mention.activeIndex) {
  const item = state.mention.items[index]
  if (!item) return

  await attachWorkspaceFile(item.path)
  const input = $("#promptInput")
  const cursor = input.selectionStart
  const before = input.value.slice(0, state.mention.start)
  const after = input.value.slice(cursor)
  const label = `@${item.path} `
  input.value = `${before}${label}${after}`
  const nextCursor = before.length + label.length
  input.focus()
  input.setSelectionRange(nextCursor, nextCursor)
  closeMentionMenu()
}

function moveMentionSelection(delta) {
  if (!state.mention.open || state.mention.items.length === 0) return
  const max = Math.min(state.mention.items.length, 10)
  state.mention.activeIndex = (state.mention.activeIndex + delta + max) % max
  renderMentionMenu()
}

function handleDragOver(event) {
  event.preventDefault()
  composerDropzone.classList.add("dragging")
  conversation.classList.add("dragging")
}

function handleDragLeave(event) {
  if (event.relatedTarget && document.body.contains(event.relatedTarget)) return
  composerDropzone.classList.remove("dragging")
  conversation.classList.remove("dragging")
}

function togglePane(className) {
  appShell.classList.toggle(className)
}

async function openSettings() {
  const response = await fetch("/api/settings")
  const data = await response.json()
  $("#settingsState").textContent = Object.entries(data.providers)
    .filter(([, value]) => value.configured)
    .map(([name]) => name)
    .join(", ") || "No keys configured"
  $("#defaultModel").value = data.defaultModel || ""
  $("#settingsDialog").showModal()
}

async function saveSettings(event) {
  event.preventDefault()
  const providers = {
    deepseek: $("#deepseekKey").value,
    openai: $("#openaiKey").value,
    anthropic: $("#anthropicKey").value,
    google: $("#googleKey").value,
    tavily: $("#tavilyKey").value,
    firecrawl: $("#firecrawlKey").value,
  }
  const response = await fetch("/api/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      providers,
      defaultModel: $("#defaultModel").value,
    }),
  })
  const data = await response.json()
  $("#settingsState").textContent = response.ok ? `Saved to ${data.settingsPath}` : "Save failed"
}

document.querySelectorAll(".mode").forEach((button) => {
  const mode = button.dataset.mode
  button.title = modeCopy[mode]?.hint ?? ""
  button.addEventListener("click", () => setMode(mode))
  button.addEventListener("mouseenter", () => {
    $("#modeHint").textContent = modeCopy[mode]?.hint ?? ""
  })
  button.addEventListener("mouseleave", () => {
    $("#modeHint").textContent = modeCopy[state.mode]?.hint ?? ""
  })
})

$("#sendButton").addEventListener("click", createTask)
$("#refreshFiles").addEventListener("click", renderFileTree)
$("#chooseWorkspace").addEventListener("click", () => openDirectoryChooser())
$("#useDirectory").addEventListener("click", (event) => {
  event.preventDefault()
  switchWorkspace()
})
$("#settingsButton").addEventListener("click", openSettings)
$("#saveSettings").addEventListener("click", saveSettings)
$("#toggleLeftPane").addEventListener("click", () => togglePane("left-collapsed"))
$("#toggleRightPane").addEventListener("click", () => togglePane("right-collapsed"))

$("#promptInput").addEventListener("keydown", (event) => {
  if (state.mention.open) {
    if (event.key === "ArrowDown") {
      event.preventDefault()
      moveMentionSelection(1)
      return
    }
    if (event.key === "ArrowUp") {
      event.preventDefault()
      moveMentionSelection(-1)
      return
    }
    if (event.key === "Tab") {
      event.preventDefault()
      selectMention()
      return
    }
    if (event.key === "Escape") {
      event.preventDefault()
      closeMentionMenu()
      return
    }
  }

  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault()
    if (state.mention.open) {
      selectMention()
    } else {
      createTask()
    }
  }
})

$("#promptInput").addEventListener("input", updateMentionMenu)
$("#promptInput").addEventListener("click", updateMentionMenu)
$("#promptInput").addEventListener("blur", () => {
  window.setTimeout(closeMentionMenu, 120)
})

window.addEventListener("dragover", handleDragOver)
window.addEventListener("dragleave", handleDragLeave)
window.addEventListener("drop", handleDroppedFiles)

loadWorkspace()
setMode("chat")
