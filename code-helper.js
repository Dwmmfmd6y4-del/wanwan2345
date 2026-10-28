// code-helper.js — 「代码助手」：让 AI 通过 GitHub 接口读取、搜索、提议修改仓库代码
// 设计：AI 只能「读」和「提议修改」，所有修改先暂存，用户在「待提交」里确认后才会真正提交到 GitHub。
// 依赖：db.js（window.db）、settings.js（window.callMcpAI）、main.js（window.openPage / closePage / toast）
// 令牌只保存在 localStorage（当前设备），不会进入配置表，也不会进入数据备份。

(function() {
  'use strict'

  var TOKEN_KEY = 'wanwan_codehelper_token'
  var CFG_KEY = 'codeHelperConfig'
  var CHAT_KEY = 'codeHelperChat'
  var SESS_KEY = 'codeHelperSessions'
  var MAX_SESSIONS = 30
  var API = 'https://api.github.com'
  var TEXT_EXT = /\.(js|mjs|cjs|jsx|ts|tsx|json|html|htm|css|scss|md|txt|svg|xml|yml|yaml|toml|py|java|kt|go|rs|c|h|cpp|sh|sql|vue|map|webmanifest)$/i
  var MAX_FILE_BYTES = 1500000
  var MAX_READ_LINES = 250
  var MAX_SEARCH_HITS = 40

  var _state = {
    view: 'chat',          // chat | settings | changes
    busy: false,
    cfg: { repo: '', branch: '' },
    msgs: [],              // { role, content, trace? }
    repoInfo: null,        // { defaultBranch, canPush }
    tree: null,            // [{ path, size }]
    treeRef: '',
    files: {},             // path -> { text, sha }
    staged: {},            // path -> { original, current, sha, isNew, edits: [{ reason, oldText, newText }] }
    toolSession: null,
    sessions: [],          // [{ id, title, msgs, updatedAt }]
    sid: '',               // 当前会话 id
    undo: [],              // 已删除的消息栈：{ msg, index }
    undoTimer: null
  }

  function mkId() {
    return 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
  }

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function(c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
    })
  }

  function getToken() {
    try { return localStorage.getItem(TOKEN_KEY) || '' } catch (_) { return '' }
  }
  function setToken(v) {
    try {
      if (v) localStorage.setItem(TOKEN_KEY, v)
      else localStorage.removeItem(TOKEN_KEY)
    } catch (_) {}
  }

  // ===== 配置与聊天记录 =====

  async function loadStored() {
    try {
      var rows = await db.config.bulkGet([CFG_KEY, CHAT_KEY, SESS_KEY])
      if (rows[0] && rows[0].value) _state.cfg = Object.assign({ repo: '', branch: '' }, rows[0].value)
      var sess = rows[2] && rows[2].value
      if (sess && Array.isArray(sess.sessions) && sess.sessions.length) {
        _state.sessions = sess.sessions
        _state.sid = sess.sid
      } else if (rows[1] && Array.isArray(rows[1].value) && rows[1].value.length) {
        _state.sessions = [{ id: mkId(), title: '', msgs: rows[1].value, updatedAt: Date.now() }]
        _state.sid = _state.sessions[0].id
      }
      var cur = _state.sessions.filter(function(x) { return x.id === _state.sid })[0]
      if (!cur && _state.sessions.length) { cur = _state.sessions[0]; _state.sid = cur.id }
      _state.msgs = cur ? cur.msgs : []
      _state.msgs.forEach(function(m) { if (!m.id) m.id = mkId() })
    } catch (_) {}
  }
  function saveCfg() {
    return db.config.put({ key: CFG_KEY, value: { repo: _state.cfg.repo, branch: _state.cfg.branch } })
  }
  function sessionTitle(msgs) {
    var first = (msgs || []).filter(function(m) { return m.role === 'user' })[0]
    var t = first ? String(first.content || '').replace(/\s+/g, ' ').trim() : ''
    return t ? t.slice(0, 24) : '新会话'
  }
  function saveChat() {
    var keep = _state.msgs.slice(-60)
    var cur = _state.sessions.filter(function(x) { return x.id === _state.sid })[0]
    if (!cur) {
      if (!keep.length) return Promise.resolve()
      cur = { id: _state.sid || mkId(), title: '', msgs: keep, updatedAt: Date.now() }
      _state.sid = cur.id
      _state.sessions.unshift(cur)
    }
    cur.msgs = keep
    cur.title = sessionTitle(keep)
    cur.updatedAt = Date.now()
    _state.sessions = _state.sessions.filter(function(x) { return x.msgs.length || x.id === _state.sid }).slice(0, MAX_SESSIONS)
    return db.config.put({ key: SESS_KEY, value: { sid: _state.sid, sessions: _state.sessions } }).catch(function() {})
  }

  // ===== 新会话 / 历史会话 =====
  function clearUndo() {
    _state.undo = []
    if (_state.undoTimer) { clearTimeout(_state.undoTimer); _state.undoTimer = null }
  }
  async function newSession() {
    if (_state.busy) { window.toast('回复进行中，稍后再开新会话'); return }
    if (!_state.msgs.length) { _state.view = 'chat'; render(); window.toast('当前已经是新会话'); return }
    await saveChat()
    var fresh = { id: mkId(), title: '新会话', msgs: [], updatedAt: Date.now() }
    _state.sessions.unshift(fresh)
    _state.sid = fresh.id
    _state.msgs = []
    clearUndo()
    _state.view = 'chat'
    await db.config.put({ key: SESS_KEY, value: { sid: _state.sid, sessions: _state.sessions } }).catch(function() {})
    render()
    window.toast('已新建会话')
  }
  function openSession(id) {
    if (_state.busy) { window.toast('回复进行中，稍后再切换'); return }
    var target = _state.sessions.filter(function(x) { return x.id === id })[0]
    if (!target) return
    _state.sid = id
    _state.msgs = target.msgs
    _state.msgs.forEach(function(m) { if (!m.id) m.id = mkId() })
    clearUndo()
    _state.view = 'chat'
    saveChat()
    render()
  }
  function deleteSession(id) {
    if (_state.busy && id === _state.sid) { window.toast('回复进行中，无法删除当前会话'); return }
    _state.sessions = _state.sessions.filter(function(x) { return x.id !== id })
    if (id === _state.sid) {
      var next = _state.sessions[0]
      _state.sid = next ? next.id : ''
      _state.msgs = next ? next.msgs : []
      clearUndo()
    }
    db.config.put({ key: SESS_KEY, value: { sid: _state.sid, sessions: _state.sessions } }).catch(function() {})
    render()
  }
  function fmtTime(ts) {
    var d = new Date(ts || Date.now())
    var p = function(n) { return (n < 10 ? '0' : '') + n }
    return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
  }
  function renderHistory(shell) {
    var rows = _state.sessions.slice().sort(function(a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0) })
    shell.innerHTML = '<div class="codehelper-history">' + (rows.length ? rows.map(function(x) {
      return '<div class="codehelper-hist-row' + (x.id === _state.sid ? ' is-current' : '') + '" data-ch-open="' + esc(x.id) + '">' +
        '<div class="codehelper-hist-info"><strong>' + esc(x.title || sessionTitle(x.msgs)) + '</strong>' +
        '<small>' + fmtTime(x.updatedAt) + ' · ' + x.msgs.length + ' 条消息' + (x.id === _state.sid ? ' · 当前' : '') + '</small></div>' +
        '<button type="button" data-ch-delsess="' + esc(x.id) + '" aria-label="删除会话"><i class="fa-solid fa-trash-can"></i></button></div>'
    }).join('') : '<div class="codehelper-empty"><i class="fa-solid fa-clock-rotate-left"></i><p>还没有历史会话</p></div>') + '</div>'
    shell.querySelectorAll('[data-ch-delsess]').forEach(function(btn) {
      btn.addEventListener('click', function(ev) {
        ev.stopPropagation()
        if (confirm('删除这个会话？删除后无法恢复。')) deleteSession(btn.getAttribute('data-ch-delsess'))
      })
    })
    shell.querySelectorAll('[data-ch-open]').forEach(function(row) {
      row.addEventListener('click', function() { openSession(row.getAttribute('data-ch-open')) })
    })
  }

  // ===== 删除 / 撤销消息 =====
  function deleteMessage(id) {
    var idx = -1
    _state.msgs.forEach(function(m, i) { if (m.id === id) idx = i })
    if (idx < 0) return
    var removed = _state.msgs.splice(idx, 1)[0]
    _state.undo.push({ msg: removed, index: idx })
    if (_state.undo.length > 20) _state.undo.shift()
    saveChat()
    renderChatBody({ keepScroll: true })
    showUndoBar()
  }
  function undoDelete() {
    var last = _state.undo.pop()
    if (!last) return
    _state.msgs.splice(Math.min(last.index, _state.msgs.length), 0, last.msg)
    saveChat()
    renderChatBody({ keepScroll: true })
    showUndoBar()
  }
  function showUndoBar() {
    var bar = document.getElementById('codehelper-undo')
    if (!bar) return
    if (_state.undoTimer) { clearTimeout(_state.undoTimer); _state.undoTimer = null }
    if (!_state.undo.length) { bar.hidden = true; return }
    bar.querySelector('span').textContent = '已删除 ' + _state.undo.length + ' 条消息'
    bar.hidden = false
    _state.undoTimer = setTimeout(function() {
      bar.hidden = true
      _state.undo = []
      _state.undoTimer = null
    }, 8000)
  }

  function parseRepo(input) {
    var s = String(input || '').trim()
    s = s.replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/\/+$/, '')
    var m = s.match(/^([\w.-]+)\/([\w.-]+)/)
    return m ? m[1] + '/' + m[2] : ''
  }

  // ===== GitHub 接口 =====

  async function gh(path, options) {
    options = options || {}
    var headers = { Accept: options.accept || 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }
    var token = getToken()
    if (token) headers.Authorization = 'Bearer ' + token
    if (options.body) headers['Content-Type'] = 'application/json'
    var res
    try {
      res = await fetch(API + path, {
        method: options.method || 'GET',
        headers: headers,
        body: options.body ? JSON.stringify(options.body) : undefined
      })
    } catch (e) {
      throw new Error('网络请求失败，请检查网络')
    }
    if (!res.ok) {
      var msg = ''
      try { msg = (await res.json()).message || '' } catch (_) {}
      if (res.status === 401) msg = 'token 无效或已过期'
      else if (res.status === 403 && /rate limit/i.test(msg)) msg = '触发 GitHub 访问频率限制，请填写 token 或稍后再试'
      else if (res.status === 404) msg = '找不到仓库或文件（私有仓库请确认 token 有该仓库的权限）'
      var err = new Error('GitHub ' + res.status + '：' + (msg || res.statusText))
      err.status = res.status
      throw err
    }
    if (options.raw) return res
    return res.json()
  }

  function encodePath(p) {
    return String(p).split('/').map(encodeURIComponent).join('/')
  }

  function b64ToText(b64) {
    var bin = atob(String(b64).replace(/\n/g, ''))
    var bytes = new Uint8Array(bin.length)
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return new TextDecoder('utf-8').decode(bytes)
  }
  function textToB64(text) {
    var bytes = new TextEncoder().encode(text)
    var bin = ''
    for (var i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
    }
    return btoa(bin)
  }

  async function ensureRepo() {
    if (!_state.cfg.repo) throw new Error('还没有设置仓库，请先点右上角齿轮填写')
    if (_state.repoInfo && _state.repoInfo.repo === _state.cfg.repo) return _state.repoInfo
    var info = await gh('/repos/' + _state.cfg.repo)
    _state.repoInfo = {
      repo: _state.cfg.repo,
      defaultBranch: info.default_branch,
      canPush: !!(info.permissions && info.permissions.push),
      isPrivate: !!info.private
    }
    return _state.repoInfo
  }

  async function currentBranch() {
    var info = await ensureRepo()
    return _state.cfg.branch || info.defaultBranch
  }

  async function ensureTree() {
    var branch = await currentBranch()
    var ref = _state.cfg.repo + '@' + branch
    if (_state.tree && _state.treeRef === ref) return _state.tree
    var data = await gh('/repos/' + _state.cfg.repo + '/git/trees/' + encodeURIComponent(branch) + '?recursive=1')
    _state.tree = (data.tree || []).filter(function(n) { return n.type === 'blob' }).map(function(n) {
      return { path: n.path, size: n.size || 0 }
    })
    _state.treeTruncated = !!data.truncated
    _state.treeRef = ref
    _state.files = {}
    return _state.tree
  }

  async function fetchFile(path) {
    var branch = await currentBranch()
    var url = '/repos/' + _state.cfg.repo + '/contents/' + encodePath(path) + '?ref=' + encodeURIComponent(branch)
    var meta = await gh(url)
    if (Array.isArray(meta)) throw new Error(path + ' 是文件夹，不是文件')
    var text
    if (meta.encoding === 'base64' && meta.content) {
      text = b64ToText(meta.content)
    } else {
      var res = await gh(url, { accept: 'application/vnd.github.raw+json', raw: true })
      text = await res.text()
    }
    var entry = { text: text, sha: meta.sha }
    _state.files[path] = entry
    return entry
  }

  async function getFileText(path) {
    var staged = _state.staged[path]
    if (staged) return staged.current
    if (_state.files[path]) return _state.files[path].text
    return (await fetchFile(path)).text
  }

  // ===== 工具实现（供 AI 调用） =====

  async function toolListFiles(args) {
    var tree = await ensureTree()
    var prefix = String(args.path_prefix || '').replace(/^\/+/, '')
    var list = tree.filter(function(n) { return !prefix || n.path.indexOf(prefix) === 0 })
    var created = Object.keys(_state.staged).filter(function(p) { return _state.staged[p].isNew && (!prefix || p.indexOf(prefix) === 0) })
    var lines = list.slice(0, 300).map(function(n) { return n.path + ' (' + n.size + 'B)' })
    created.forEach(function(p) { lines.push(p + ' (新文件，待提交)') })
    return JSON.stringify({
      total: list.length,
      shown: Math.min(list.length, 300),
      truncated_tree: !!_state.treeTruncated,
      files: lines
    })
  }

  async function toolReadFile(args) {
    var path = String(args.path || '').replace(/^\/+/, '')
    if (!path) throw new Error('缺少 path')
    var text = await getFileText(path)
    var lines = text.split('\n')
    var start = Math.max(1, parseInt(args.start_line, 10) || 1)
    var end = Math.min(lines.length, parseInt(args.end_line, 10) || (start + MAX_READ_LINES - 1))
    if (end - start + 1 > MAX_READ_LINES) end = start + MAX_READ_LINES - 1
    var out = []
    for (var i = start - 1; i < end; i++) {
      var line = lines[i]
      if (line.length > 400) line = line.slice(0, 400) + '…(该行过长已截断)'
      out.push((i + 1) + '| ' + line)
    }
    return JSON.stringify({
      path: path,
      total_lines: lines.length,
      from: start,
      to: end,
      staged_version: !!_state.staged[path],
      content: out.join('\n')
    })
  }

  async function toolSearchCode(args, onProgress) {
    var query = String(args.query || '')
    if (!query) throw new Error('缺少 query')
    var tree = await ensureTree()
    var prefix = String(args.path_prefix || '').replace(/^\/+/, '')
    var re
    try {
      re = args.is_regex ? new RegExp(query, 'i') : null
    } catch (e) { throw new Error('正则表达式无效：' + e.message) }
    var needle = query.toLowerCase()
    var candidates = tree.filter(function(n) {
      return TEXT_EXT.test(n.path) && n.size <= MAX_FILE_BYTES && (!prefix || n.path.indexOf(prefix) === 0)
    })
    var toFetch = candidates.filter(function(n) { return !_state.files[n.path] && !_state.staged[n.path] })
    var done = 0
    var cursor = 0
    var errors = 0
    async function worker() {
      while (cursor < toFetch.length) {
        var node = toFetch[cursor++]
        try { await fetchFile(node.path) } catch (_) { errors++ }
        done++
        if (onProgress) onProgress(done, toFetch.length)
      }
    }
    await Promise.all([worker(), worker(), worker(), worker()])
    var hits = []
    var truncated = false
    for (var i = 0; i < candidates.length && !truncated; i++) {
      var p = candidates[i].path
      var text = _state.staged[p] ? _state.staged[p].current : (_state.files[p] && _state.files[p].text)
      if (typeof text !== 'string') continue
      var lines = text.split('\n')
      for (var j = 0; j < lines.length; j++) {
        var hit = re ? re.test(lines[j]) : lines[j].toLowerCase().indexOf(needle) >= 0
        if (hit) {
          var shown = lines[j].trim()
          if (shown.length > 200) shown = shown.slice(0, 200) + '…'
          hits.push(p + ':' + (j + 1) + ': ' + shown)
          if (hits.length >= MAX_SEARCH_HITS) { truncated = true; break }
        }
      }
    }
    return JSON.stringify({
      searched_files: candidates.length,
      failed_files: errors,
      hits: hits.length,
      truncated: truncated,
      results: hits
    })
  }

  function countOccurrences(text, part) {
    if (!part) return 0
    var n = 0
    var idx = 0
    while ((idx = text.indexOf(part, idx)) !== -1) { n++; idx += part.length }
    return n
  }

  async function toolProposeEdit(args) {
    var path = String(args.path || '').replace(/^\/+/, '')
    var oldText = String(args.old_text == null ? '' : args.old_text)
    var newText = String(args.new_text == null ? '' : args.new_text)
    if (!path) throw new Error('缺少 path')
    if (!oldText) throw new Error('old_text 不能为空；新建文件请用 create_file')
    if (oldText === newText) throw new Error('old_text 与 new_text 相同，没有修改')
    var entry = _state.staged[path]
    var current
    var sha
    if (entry) {
      current = entry.current
    } else {
      var f = _state.files[path] || await fetchFile(path)
      current = f.text
      sha = f.sha
    }
    var n = countOccurrences(current, oldText)
    if (n === 0) throw new Error('在 ' + path + ' 中找不到 old_text，请先用 read_file 读取最新内容，并原样复制要替换的片段（含缩进）')
    if (n > 1) throw new Error('old_text 在 ' + path + ' 中出现了 ' + n + ' 次，请多带几行上下文让它唯一')
    var next = current.replace(oldText, function() { return newText })
    if (!entry) {
      entry = _state.staged[path] = { original: current, current: current, sha: sha, isNew: false, edits: [] }
    }
    entry.current = next
    entry.edits.push({ reason: String(args.reason || ''), oldText: oldText, newText: newText })
    _state.toolSession.cache = {}
    refreshBadge()
    return JSON.stringify({ ok: true, path: path, note: '修改已暂存，尚未提交到 GitHub，需要用户在「待提交」里确认。' })
  }

  async function toolCreateFile(args) {
    var path = String(args.path || '').replace(/^\/+/, '')
    var content = String(args.content == null ? '' : args.content)
    if (!path) throw new Error('缺少 path')
    var tree = await ensureTree()
    var exists = tree.some(function(n) { return n.path === path })
    if (exists && !_state.staged[path]) throw new Error(path + ' 已存在，请用 propose_edit 修改')
    var entry = _state.staged[path]
    if (entry && !entry.isNew) throw new Error(path + ' 已有待提交的修改，请用 propose_edit 继续修改')
    _state.staged[path] = { original: '', current: content, sha: null, isNew: true, edits: [{ reason: String(args.reason || ''), oldText: '', newText: content }] }
    _state.toolSession.cache = {}
    refreshBadge()
    return JSON.stringify({ ok: true, path: path, note: '新文件已暂存，尚未提交到 GitHub。' })
  }

  var TOOL_DEFS = [
    {
      type: 'function',
      function: {
        name: 'list_files',
        description: '列出仓库文件（可按路径前缀过滤，例如 "js/"）。不确定文件在哪时先用它。',
        parameters: { type: 'object', properties: { path_prefix: { type: 'string', description: '路径前缀，可留空' } } }
      }
    },
    {
      type: 'function',
      function: {
        name: 'search_code',
        description: '在仓库文本文件中搜索字符串或正则，返回「文件:行号: 内容」。排查问题时优先使用。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '要搜索的文本或正则' },
            is_regex: { type: 'boolean', description: 'query 是否为正则，默认否' },
            path_prefix: { type: 'string', description: '只搜索该前缀下的文件，可留空' }
          },
          required: ['query']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: '读取文件内容（带行号），一次最多 ' + MAX_READ_LINES + ' 行；大文件请用 start_line / end_line 分段读。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            start_line: { type: 'integer' },
            end_line: { type: 'integer' }
          },
          required: ['path']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'propose_edit',
        description: '提议修改文件：把 old_text 精确替换成 new_text。old_text 必须原样复制自文件且在文件中唯一。修改只是暂存，用户确认后才会提交。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            old_text: { type: 'string', description: '要被替换的原文片段，需包含足够上下文以保证唯一' },
            new_text: { type: 'string', description: '替换后的内容' },
            reason: { type: 'string', description: '一句话说明为什么这样改' }
          },
          required: ['path', 'old_text', 'new_text']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'create_file',
        description: '提议新建一个文件（路径必须不存在）。同样只是暂存，用户确认后才会提交。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            content: { type: 'string' },
            reason: { type: 'string' }
          },
          required: ['path', 'content']
        }
      }
    }
  ]

  var TOOL_LABELS = {
    list_files: function(a) { return '查看文件列表' + (a.path_prefix ? '：' + a.path_prefix : '') },
    search_code: function(a) { return '搜索：' + (a.query || '') },
    read_file: function(a) { return '读取：' + (a.path || '') + (a.start_line ? ' 第' + a.start_line + '行起' : '') },
    propose_edit: function(a) { return '提议修改：' + (a.path || '') },
    create_file: function(a) { return '提议新建：' + (a.path || '') }
  }

  async function runTool(name, args, onProgress) {
    if (name === 'list_files') return await toolListFiles(args)
    if (name === 'search_code') return await toolSearchCode(args, onProgress)
    if (name === 'read_file') return await toolReadFile(args)
    if (name === 'propose_edit') return await toolProposeEdit(args)
    if (name === 'create_file') return await toolCreateFile(args)
    throw new Error('未知工具：' + name)
  }

  // ===== AI 对话 =====

  function buildSystemPrompt(branch) {
    return [
      '你是「代码助手」，在一个手机端网页应用里帮用户查找、排查、修改 GitHub 仓库中的代码。',
      '当前仓库：' + _state.cfg.repo + '，分支：' + branch + '。',
      '',
      '工作方式：',
      '1. 先用 search_code / list_files 定位，再用 read_file 阅读相关代码，不要凭记忆或猜测回答。',
      '2. 排查问题时说清楚：原因在哪个文件的哪一行、为什么出错。',
      '3. 需要修改时调用 propose_edit（精确替换）或 create_file。old_text 必须原样复制自 read_file 的内容（不含行号前缀），并保证在文件中唯一。每次只改必要的部分，不要顺手重构。',
      '4. 你的修改只是暂存，不会自动提交。回复里要告诉用户改了哪些文件、改了什么，并提醒用户到右上角「待提交」检查后再提交。',
      '5. 工具返回错误时，根据错误信息调整后重试，不要编造结果。',
      '6. 回答用简体中文，简洁清楚；代码用 ``` 代码块。',
      '7. 不要要求或输出用户的 token。'
    ].join('\n')
  }

  function chatMessagesForApi() {
    var out = []
    _state.msgs.slice(-24).forEach(function(m) {
      if (m.role === 'user' || m.role === 'assistant') out.push({ role: m.role, content: m.content })
    })
    return out
  }

  async function sendMessage(text) {
    if (_state.busy) return
    text = String(text || '').trim()
    if (!text) return
    if (typeof window.callMcpAI !== 'function') { window.toast('AI 接口未就绪'); return }
    _state.busy = true
    _state.msgs.push({ id: mkId(), role: 'user', content: text })
    var reply = { id: mkId(), role: 'assistant', content: '', trace: [] }
    renderChatBody({ pending: reply })
    setComposerBusy(true)
    try {
      var branch = await currentBranch()
      _state.toolSession = { cache: {}, records: [], contextMessages: [] }
      var answer = await window.callMcpAI(chatMessagesForApi(), {
        system: buildSystemPrompt(branch),
        tools: TOOL_DEFS,
        maxToolCalls: 30,
        toolSession: _state.toolSession,
        toolExecutor: async function(name, args) {
          var statusLine = reply.trace[reply.trace.length - 1]
          return await runTool(name, args, function(done, total) {
            if (statusLine) {
              statusLine.detail = '正在加载文件 ' + done + '/' + total
              renderChatBody({ pending: reply })
            }
          })
        },
        toolObserver: function(ev) {
          if (ev.phase === 'start') {
            var label = TOOL_LABELS[ev.name] ? TOOL_LABELS[ev.name](ev.arguments || {}) : ev.name
            reply.trace.push({ name: ev.name, label: label, status: 'running', detail: '' })
          } else if (ev.phase === 'finish') {
            var last = reply.trace[reply.trace.length - 1]
            if (last) {
              last.status = ev.status === 'error' ? 'error' : 'ok'
              last.detail = ''
              if (ev.status === 'error' && ev.error) last.detail = String(ev.error).slice(0, 120)
            }
          }
          renderChatBody({ pending: reply })
        }
      })
      reply.content = String(answer || '').trim() || '（没有收到回复）'
    } catch (e) {
      reply.content = '出错了：' + (e && e.message ? e.message : e)
      reply.isError = true
    }
    reply.trace.forEach(function(t) { if (t.status === 'running') t.status = 'error' })
    _state.msgs.push(reply)
    _state.busy = false
    saveChat()
    renderChatBody({})
    setComposerBusy(false)
    refreshBadge()
  }

  // ===== 提交到 GitHub =====

  function stagedPaths() { return Object.keys(_state.staged) }

  async function commitAll(message) {
    var info = await ensureRepo()
    if (!getToken()) throw new Error('提交需要 token，请先在设置里填写（需要 Contents 读写权限）')
    if (!info.canPush) throw new Error('当前 token 对这个仓库没有写入权限')
    var branch = await currentBranch()
    var paths = stagedPaths()
    var done = []
    for (var i = 0; i < paths.length; i++) {
      var p = paths[i]
      var entry = _state.staged[p]
      var body = { message: message, content: textToB64(entry.current), branch: branch }
      if (!entry.isNew) body.sha = entry.sha
      try {
        var res = await gh('/repos/' + _state.cfg.repo + '/contents/' + encodePath(p), { method: 'PUT', body: body })
        _state.files[p] = { text: entry.current, sha: res.content && res.content.sha }
        if (entry.isNew && _state.tree) _state.tree.push({ path: p, size: entry.current.length })
        delete _state.staged[p]
        done.push(p)
      } catch (e) {
        var hint = (e.status === 409 || e.status === 422) ? '（文件可能在 GitHub 上被改动过，请放弃该文件的修改后让 AI 重新读取再改）' : ''
        var err = new Error('提交 ' + p + ' 失败：' + e.message + hint)
        err.done = done
        throw err
      }
    }
    return done
  }

  // ===== 界面 =====

  function createPage() {
    var page = document.createElement('div')
    page.id = 'codehelper-page'
    page.className = 'full-page codehelper-page'
    page.innerHTML =
      '<header class="page-header codehelper-header">' +
        '<button class="header-back" type="button" aria-label="返回"><i class="fa fa-angle-left"></i></button>' +
        '<div class="codehelper-title-wrap"><span class="header-title">代码助手</span><small id="codehelper-sub"></small></div>' +
        '<button class="codehelper-hbtn" type="button" data-ch-new aria-label="新会话"><i class="fa-solid fa-plus"></i></button>' +
        '<button class="codehelper-hbtn" type="button" data-ch-history aria-label="历史会话"><i class="fa-solid fa-clock-rotate-left"></i></button>' +
        '<button class="codehelper-hbtn" type="button" data-ch-changes aria-label="待提交"><i class="fa-solid fa-code-commit"></i><span class="codehelper-badge" id="codehelper-badge" hidden>0</span></button>' +
        '<button class="codehelper-hbtn" type="button" data-ch-settings aria-label="设置"><i class="fa-solid fa-gear"></i></button>' +
      '</header>' +
      '<main class="codehelper-shell" id="codehelper-shell"></main>'
    page.querySelector('.header-back').addEventListener('click', function() {
      if (_state.view === 'chat') window.closePage('codehelper-page')
      else { _state.view = 'chat'; render() }
    })
    page.querySelector('[data-ch-new]').addEventListener('click', function() { newSession() })
    page.querySelector('[data-ch-history]').addEventListener('click', function() {
      _state.view = _state.view === 'history' ? 'chat' : 'history'
      render()
    })
    page.querySelector('[data-ch-settings]').addEventListener('click', function() {
      _state.view = _state.view === 'settings' ? 'chat' : 'settings'
      render()
    })
    page.querySelector('[data-ch-changes]').addEventListener('click', function() {
      _state.view = _state.view === 'changes' ? 'chat' : 'changes'
      render()
    })
    return page
  }

  function refreshBadge() {
    var badge = document.getElementById('codehelper-badge')
    if (!badge) return
    var n = stagedPaths().length
    badge.textContent = String(n)
    badge.hidden = n === 0
  }

  function setComposerBusy(busy) {
    var input = document.getElementById('codehelper-input')
    var btn = document.getElementById('codehelper-send')
    if (input) input.disabled = busy
    if (btn) { btn.disabled = busy; btn.innerHTML = busy ? '<i class="fa-solid fa-spinner fa-spin"></i>' : '<i class="fa-solid fa-arrow-up"></i>' }
  }

  function renderRichText(text) {
    var parts = String(text || '').split(/```/)
    return parts.map(function(part, i) {
      if (i % 2 === 1) {
        var code = part.replace(/^[^\n]*\n/, '')
        return '<pre class="codehelper-code"><code>' + esc(code.replace(/\n$/, '')) + '</code></pre>'
      }
      return esc(part).replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>')
    }).join('')
  }

  function traceHtml(trace) {
    if (!trace || !trace.length) return ''
    return '<div class="codehelper-trace">' + trace.map(function(t) {
      var icon = t.status === 'running' ? 'fa-spinner fa-spin' : (t.status === 'error' ? 'fa-triangle-exclamation' : 'fa-check')
      return '<div class="codehelper-trace-item is-' + t.status + '"><i class="fa-solid ' + icon + '"></i><span>' + esc(t.label) +
        (t.detail ? '<em>' + esc(t.detail) + '</em>' : '') + '</span></div>'
    }).join('') + '</div>'
  }

  function msgTools(m) {
    return '<div class="codehelper-msg-tools">' +
      '<button type="button" data-ch-copy="' + esc(m.id) + '"><i class="fa-regular fa-copy"></i>复制</button>' +
      '<button type="button" class="is-danger" data-ch-del="' + esc(m.id) + '"><i class="fa-solid fa-trash-can"></i>删除</button></div>'
  }

  function msgHtml(m) {
    if (m.role === 'user') return '<div class="codehelper-msg is-user" data-mid="' + esc(m.id) + '"><div class="codehelper-bubble">' + esc(m.content).replace(/\n/g, '<br>') + '</div>' + msgTools(m) + '</div>'
    return '<div class="codehelper-msg is-ai" data-mid="' + esc(m.id) + '">' + traceHtml(m.trace) +
      (m.content ? '<div class="codehelper-bubble' + (m.isError ? ' is-error' : '') + '">' + renderRichText(m.content) + '</div>' + msgTools(m) : '') + '</div>'
  }

  function renderChatBody(opts) {
    var box = document.getElementById('codehelper-messages')
    if (!box) return
    opts = opts || {}
    var html = _state.msgs.map(msgHtml).join('')
    if (opts.pending) {
      html += '<div class="codehelper-msg is-ai">' + traceHtml(opts.pending.trace) +
        (opts.pending.trace.length ? '' : '<div class="codehelper-bubble codehelper-thinking"><i class="fa-solid fa-ellipsis fa-fade"></i></div>') + '</div>'
    }
    if (!html) {
      html = '<div class="codehelper-empty"><i class="fa-solid fa-code"></i><p>告诉我想查什么、改什么</p>' +
        '<div class="codehelper-chips">' +
        '<button type="button" data-ch-chip="帮我看看这个仓库的整体结构，每个文件夹是做什么的">看看仓库结构</button>' +
        '<button type="button" data-ch-chip="帮我排查：">排查一个问题</button>' +
        '<button type="button" data-ch-chip="帮我搜索代码里所有用到「」的地方">搜索某个功能</button>' +
        '</div></div>'
    }
    var prevTop = box.scrollTop
    box.innerHTML = html
    box.scrollTop = opts.keepScroll ? prevTop : box.scrollHeight
  }

  function renderChat(shell) {
    var ready = !!_state.cfg.repo
    shell.innerHTML =
      '<div class="codehelper-messages" id="codehelper-messages"></div>' +
      '<div class="codehelper-undo" id="codehelper-undo" hidden><span></span><button type="button" data-ch-undo>撤销</button></div>' +
      (ready ? '' : '<div class="codehelper-hint"><i class="fa-solid fa-circle-info"></i>先点右上角齿轮，填写要处理的 GitHub 仓库</div>') +
      '<form class="codehelper-composer" id="codehelper-form">' +
        '<textarea id="codehelper-input" rows="1" placeholder="描述要排查或修改的问题…"></textarea>' +
        '<button id="codehelper-send" type="submit" aria-label="发送"><i class="fa-solid fa-arrow-up"></i></button>' +
      '</form>'
    renderChatBody(_state.busy ? { pending: { trace: [] } } : {})
    var input = shell.querySelector('#codehelper-input')
    input.addEventListener('input', function() {
      input.style.height = 'auto'
      input.style.height = Math.min(input.scrollHeight, 120) + 'px'
    })
    shell.querySelector('#codehelper-form').addEventListener('submit', function(ev) {
      ev.preventDefault()
      var text = input.value
      if (!_state.cfg.repo) { window.toast('请先设置仓库'); _state.view = 'settings'; render(); return }
      input.value = ''
      input.style.height = 'auto'
      sendMessage(text)
    })
    shell.querySelector('#codehelper-messages').addEventListener('click', function(ev) {
      var t = ev.target
      var chip = t.closest && t.closest('[data-ch-chip]')
      if (chip) { input.value = chip.getAttribute('data-ch-chip'); input.focus(); return }
      var del = t.closest && t.closest('[data-ch-del]')
      if (del) { deleteMessage(del.getAttribute('data-ch-del')); return }
      var cp = t.closest && t.closest('[data-ch-copy]')
      if (cp) {
        var mid = cp.getAttribute('data-ch-copy')
        var found = _state.msgs.filter(function(m) { return m.id === mid })[0]
        if (found && navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(String(found.content || '')).then(function() { window.toast('已复制') }, function() { window.toast('复制失败') })
        } else window.toast('复制失败')
        return
      }
      var bubble = t.closest && t.closest('.codehelper-bubble')
      var msg = bubble && bubble.closest('.codehelper-msg')
      if (msg && msg.getAttribute('data-mid') && !bubble.classList.contains('codehelper-thinking')) {
        var wasPicked = msg.classList.contains('is-picked')
        shell.querySelectorAll('.codehelper-msg.is-picked').forEach(function(n) { n.classList.remove('is-picked') })
        if (!wasPicked) msg.classList.add('is-picked')
      }
    })
    shell.querySelector('[data-ch-undo]').addEventListener('click', undoDelete)
    showUndoBar()
    setComposerBusy(_state.busy)
  }

  function renderSettings(shell) {
    var hasToken = !!getToken()
    shell.innerHTML =
      '<form class="codehelper-form" id="codehelper-settings">' +
        '<label class="codehelper-field"><span>GitHub 仓库</span><input id="ch-repo" autocapitalize="none" autocomplete="off" placeholder="用户名/仓库名 或仓库网址" value="' + esc(_state.cfg.repo) + '"></label>' +
        '<label class="codehelper-field"><span>分支 <small>留空使用默认分支</small></span><input id="ch-branch" autocapitalize="none" autocomplete="off" placeholder="main" value="' + esc(_state.cfg.branch) + '"></label>' +
        '<label class="codehelper-field"><span>GitHub Token <small>' + (hasToken ? '已保存在本机，留空则保留' : '公开仓库只读可不填') + '</small></span><input id="ch-token" type="password" autocomplete="off" placeholder="' + (hasToken ? '••••••••' : 'github_pat_…') + '"></label>' +
        (hasToken ? '<button class="codehelper-danger" type="button" id="ch-clear-token">清除已保存的 token</button>' : '') +
        '<div class="codehelper-note"><i class="fa-solid fa-shield-halved"></i><span>token 只保存在当前设备，不会进入备份。建议在 GitHub 创建 Fine-grained token，只选这一个仓库，权限给 Contents（读写）。只想让 AI 看代码就给只读。</span></div>' +
        '<button class="codehelper-primary" type="submit">保存并测试连接</button>' +
        '<div class="codehelper-status" id="ch-status"></div>' +
      '</form>'
    var status = shell.querySelector('#ch-status')
    var clear = shell.querySelector('#ch-clear-token')
    if (clear) clear.addEventListener('click', function() { setToken(''); window.toast('已清除 token'); renderSettings(shell) })
    shell.querySelector('#codehelper-settings').addEventListener('submit', async function(ev) {
      ev.preventDefault()
      var repo = parseRepo(shell.querySelector('#ch-repo').value)
      if (!repo) { status.className = 'codehelper-status is-error'; status.textContent = '仓库格式不对，应为 用户名/仓库名'; return }
      var tokenInput = shell.querySelector('#ch-token').value.trim()
      if (tokenInput) setToken(tokenInput)
      var changed = repo !== _state.cfg.repo || shell.querySelector('#ch-branch').value.trim() !== _state.cfg.branch
      if (changed && stagedPaths().length) {
        if (!window.confirm('切换仓库或分支会放弃尚未提交的修改，继续吗？')) return
      }
      _state.cfg = { repo: repo, branch: shell.querySelector('#ch-branch').value.trim() }
      if (changed) { _state.repoInfo = null; _state.tree = null; _state.files = {}; _state.staged = {} }
      status.className = 'codehelper-status'
      status.textContent = '正在连接…'
      try {
        await saveCfg()
        var info = await ensureRepo()
        var tree = await ensureTree()
        status.className = 'codehelper-status is-ok'
        status.textContent = '连接成功：' + tree.length + ' 个文件，分支 ' + (await currentBranch()) + '，' + (info.canPush ? '可以提交修改' : (getToken() ? 'token 没有写入权限，只能读取' : '未填 token，只能读取公开内容')) + (_state.treeTruncated ? '（文件太多，列表不完整）' : '')
        refreshBadge()
        updateSub()
      } catch (e) {
        status.className = 'codehelper-status is-error'
        status.textContent = e.message
      }
    })
  }

  function renderChanges(shell) {
    var paths = stagedPaths()
    if (!paths.length) {
      shell.innerHTML = '<div class="codehelper-empty"><i class="fa-solid fa-code-commit"></i><p>还没有待提交的修改</p><small>AI 提议的修改会先出现在这里，由你确认后再提交</small></div>'
      return
    }
    var html = paths.map(function(p) {
      var entry = _state.staged[p]
      var edits = entry.edits.map(function(e) {
        var oldLines = e.oldText ? e.oldText.split('\n').map(function(l) { return '<div class="codehelper-diff-del">- ' + esc(l) + '</div>' }).join('') : ''
        var newLines = e.newText.split('\n').slice(0, 80).map(function(l) { return '<div class="codehelper-diff-add">+ ' + esc(l) + '</div>' }).join('')
        return '<div class="codehelper-edit">' + (e.reason ? '<p>' + esc(e.reason) + '</p>' : '') + '<div class="codehelper-diff">' + oldLines + newLines + '</div></div>'
      }).join('')
      return '<section class="codehelper-change" data-path="' + esc(p) + '">' +
        '<div class="codehelper-change-head"><strong>' + esc(p) + '</strong>' + (entry.isNew ? '<em>新文件</em>' : '<em>' + entry.edits.length + ' 处修改</em>') +
        '<button type="button" data-ch-discard="' + esc(p) + '">放弃</button></div>' + edits + '</section>'
    }).join('')
    shell.innerHTML = html +
      '<div class="codehelper-commit">' +
        '<label class="codehelper-field"><span>提交说明</span><input id="ch-message" maxlength="120" value="' + esc('代码助手：修改 ' + paths.length + ' 个文件') + '"></label>' +
        '<button class="codehelper-primary" id="ch-commit" type="button">提交到 ' + esc(_state.cfg.repo) + '</button>' +
        '<button class="codehelper-danger" id="ch-discard-all" type="button">放弃全部修改</button>' +
        '<div class="codehelper-status" id="ch-commit-status"></div>' +
      '</div>'
    shell.querySelectorAll('[data-ch-discard]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        delete _state.staged[btn.getAttribute('data-ch-discard')]
        refreshBadge()
        renderChanges(shell)
      })
    })
    shell.querySelector('#ch-discard-all').addEventListener('click', function() {
      if (!window.confirm('放弃所有待提交的修改？')) return
      _state.staged = {}
      refreshBadge()
      renderChanges(shell)
    })
    shell.querySelector('#ch-commit').addEventListener('click', async function() {
      var status = shell.querySelector('#ch-commit-status')
      var message = shell.querySelector('#ch-message').value.trim()
      if (!message) { status.className = 'codehelper-status is-error'; status.textContent = '请填写提交说明'; return }
      if (!window.confirm('确认把 ' + paths.length + ' 个文件的修改提交到 GitHub？')) return
      var btn = shell.querySelector('#ch-commit')
      btn.disabled = true
      status.className = 'codehelper-status'
      status.textContent = '正在提交…'
      try {
        var done = await commitAll(message)
        window.toast('已提交 ' + done.length + ' 个文件')
        refreshBadge()
        renderChanges(shell)
      } catch (e) {
        btn.disabled = false
        status.className = 'codehelper-status is-error'
        status.textContent = e.message + (e.done && e.done.length ? '（已成功提交：' + e.done.join('、') + '）' : '')
        refreshBadge()
      }
    })
  }

  function updateSub() {
    var el = document.getElementById('codehelper-sub')
    if (el) el.textContent = _state.cfg.repo ? _state.cfg.repo : 'GITHUB CODE HELPER'
  }

  function render() {
    var shell = document.getElementById('codehelper-shell')
    if (!shell) return
    updateSub()
    refreshBadge()
    var title = document.querySelector('#codehelper-page .header-title')
    if (title) title.textContent = _state.view === 'settings' ? '设置' : (_state.view === 'changes' ? '待提交' : (_state.view === 'history' ? '历史会话' : '代码助手'))
    if (_state.view === 'settings') renderSettings(shell)
    else if (_state.view === 'changes') renderChanges(shell)
    else if (_state.view === 'history') renderHistory(shell)
    else renderChat(shell)
  }

  async function showCodeHelperPage() {
    if (document.getElementById('codehelper-page')) return
    await loadStored()
    _state.view = _state.cfg.repo ? 'chat' : 'settings'
    var page = createPage()
    window.openPage(page)
    render()
  }

  window.showCodeHelperPage = showCodeHelperPage

  // 注册到主屏幕第二页（与「终端」并列）；home.js 已先加载，开屏点击后才会渲染桌面
  try {
    if (typeof DESKTOP_PAGE2_ICONS !== 'undefined' && !DESKTOP_PAGE2_ICONS.some(function(i) { return i.id === 'codeHelper' })) {
      DESKTOP_PAGE2_ICONS.push({
        id: 'codeHelper',
        fa: 'fa-solid fa-code',
        label: '代码助手',
        action: function() { window.showCodeHelperPage && window.showCodeHelperPage() }
      })
    }
  } catch (_) {}
})()
