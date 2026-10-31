import ts from 'typescript'
import fs from 'node:fs'
import path from 'node:path'
import { files, title, identifier, walk } from './generate-proto'
import type { Field, Message, Service, Rpc } from './generate-proto'

type Shape = Pick<Field, 'type' | 'repeated' | 'note'>
const VALUE = 'google.protobuf.Value'
const normalized = (s: string) => s.replaceAll('\\', '/')
const unwrap = (e: ts.Expression): ts.Expression => ts.isAsExpression(e) || ts.isParenthesizedExpression(e) || ts.isTypeAssertionExpression(e) || ts.isNonNullExpression(e) ? unwrap(e.expression) : e
export class Analysis {
  program: ts.Program
  checker: ts.TypeChecker
  messages = new Map<string, Message>()
  services = new Map<string, Service>()
  typeNames = new Map<ts.Type, string>()
  unresolved: { source: string; context: string; reason: string }[] = []
  httpRoutes: object[] = []
  wsEvents: object[] = []
  ignored: object[] = []
  shared: string
  repo: string
  rootFiles: string[]
  constructor(public root: string) {
    this.shared = path.resolve(root, '../shared')
    this.repo = path.resolve(root, '../..')
    this.rootFiles = [...files(root), ...files(this.shared)].filter(f => !normalized(f).includes('/scripts/') && !/\.(test|spec)\./.test(f))
    const config = ts.readConfigFile(path.join(root, 'tsconfig.json'), ts.sys.readFile)
    const opts = ts.parseJsonConfigFileContent(config.config ?? {}, ts.sys, root).options
    this.program = ts.createProgram(this.rootFiles, { ...opts, allowJs: true, checkJs: true, strictNullChecks: true, noEmit: true })
    this.checker = this.program.getTypeChecker()
  }
  rel(file: string) { return normalized(path.relative(this.root, file)) }
  add(m: Message) {
    if (this.messages.has(m.name)) throw Error(`Duplicate message name: ${m.name}`)
    if (new Set(m.fields.map(f => identifier(f.name))).size !== m.fields.length) throw Error(`Duplicate field name in ${m.name}`)
    this.messages.set(m.name, m)
    return m.name
  }
  unknown(context: string, source: string, reason: string): Shape {
    this.unresolved.push({ source, context, reason })
    return { type: VALUE, note: `Unresolved: ${reason}` }
  }
  shape(t: ts.Type, label: string, source: string, depth = 0): Shape {
    const c = this.checker
    t = c.getAwaitedType(t) ?? t
    if (t.isUnion()) {
      const variants = t.types.filter(x => !(x.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Never)))
      if (variants.length === 1) return this.shape(variants[0], label, source, depth)
      if (variants.length && variants.every(x => x.flags & ts.TypeFlags.StringLike)) return { type: 'string', note: `TS union: ${c.typeToString(t).slice(0, 240)}` }
      if (variants.length && variants.every(x => x.flags & ts.TypeFlags.BooleanLike)) return { type: 'bool' }
      if (variants.length && variants.every(x => x.flags & ts.TypeFlags.NumberLike)) return { type: 'double' }
      return this.unknown(label, source, `heterogeneous union ${c.typeToString(t).slice(0, 160)}`)
    }
    if (t.flags & ts.TypeFlags.StringLike) return { type: 'string' }
    if (t.flags & ts.TypeFlags.NumberLike) return { type: 'double', note: 'TS number; integer semantics not declared.' }
    if (t.flags & ts.TypeFlags.BooleanLike) return { type: 'bool' }
    if (t.flags & ts.TypeFlags.BigIntLike) return { type: 'int64', note: 'Adapter must range-check BigInt for signed 64-bit.' }
    if (t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) return this.unknown(label, source, c.typeToString(t))
    if (t.flags & (ts.TypeFlags.Void | ts.TypeFlags.Undefined | ts.TypeFlags.Never | ts.TypeFlags.Null)) return { type: VALUE, note: `TS ${c.typeToString(t)}; preserve null/absence in adapter.` }
    const symbol = t.getSymbol()
    if (symbol?.name === 'Date') return { type: 'google.protobuf.Timestamp', note: 'Adapter converts JS Date/JSON date to Timestamp.' }
    if (['Buffer', 'Uint8Array', 'ArrayBuffer'].includes(symbol?.name ?? '')) return { type: 'bytes' }
    if (c.isArrayType(t)) {
      const elem = c.getTypeArguments(t as ts.TypeReference)[0]
      const item = this.shape(elem, label + 'Item', source, depth + 1)
      if (item.repeated || item.type.startsWith('map<')) return { type: this.add({ name: label + 'ItemList', fields: [{ name: 'items', ...item }], source }), repeated: true }
      return { ...item, repeated: true }
    }
    if (c.isTupleType(t)) return this.unknown(label, source, 'tuple; use JSON array in Value to preserve positional semantics')
    if (t.getCallSignatures().length || t.getConstructSignatures().length) return this.unknown(label, source, 'callable/runtime object, not a declared data DTO')
    if (depth > 9) return this.unknown(label, source, 'recursive inference depth limit')
    if (this.typeNames.has(t)) return { type: this.typeNames.get(t)! }
    const props = c.getPropertiesOfType(t).filter(p => !p.name.startsWith('__@'))
    const index = c.getIndexTypeOfType(t, ts.IndexKind.String)
    if (!props.length && index) {
      const item = this.shape(index, label + 'Entry', source, depth + 1)
      // protobuf maps cannot hold repeated values directly; wrap them.
      const value = item.repeated ? this.add({ name: label + 'EntryList', fields: [{ name: 'items', ...item }], source }) : item.type
      return { type: `map<string, ${value}>`, note: 'TS string index/Record mapped to protobuf map.' }
    }
    const decl = symbol?.declarations?.[0]
    if (decl && normalized(decl.getSourceFile().fileName).includes('/node_modules/') && !t.aliasSymbol) return this.unknown(label, source, `external runtime type ${symbol?.name}`)
    if (props.length > 100) return this.unknown(label, source, `runtime object has ${props.length} properties, not a DTO`)
    if (!props.length && !index) return this.unknown(label, source, `unstructured type ${c.typeToString(t).slice(0, 120)}`)
    let name = label
    for (let i = 2; this.messages.has(name); i++) name = label + i
    this.typeNames.set(t, name)
    const msg: Message = { name, fields: [], source }
    this.add(msg)
    for (const p of props) {
      const at = p.valueDeclaration ?? p.declarations?.[0]
      if (!at) continue
      const pt = c.getTypeOfSymbolAtLocation(p, at)
      // Methods in infrastructure types are not serializable.
      if (pt.getCallSignatures().length) continue
      const mapped = this.shape(pt, name + title(p.name), source, depth + 1)
      const isMap = mapped.type.startsWith('map<')
      msg.fields.push({ name: p.name, ...mapped, optional: !mapped.repeated && !isMap })
    }
    if (index) {
      let field = 'additional_properties'
      while (msg.fields.some(p => p.name === field)) field += '_'
      msg.fields.push({ name: field, type: 'google.protobuf.Struct', note: 'TS index signature; adapter collects keys not listed above.' })
    }
    return { type: name }
  }
  box(shape: Shape, name: string, source: string): string {
    if (this.messages.has(shape.type) && !shape.repeated) return shape.type
    return this.add({ name, fields: [{ name: 'value', ...shape, optional: !shape.repeated && !shape.type.startsWith('map<') }], source })
  }
  handler(sf: ts.SourceFile): ts.FunctionLikeDeclaration | undefined {
    let found: ts.FunctionLikeDeclaration | undefined
    walk(sf, n => {
      if ((ts.isPropertyAssignment(n) || ts.isPropertyDeclaration(n)) && ['fn', 'handler'].includes(n.name.getText(sf)) && n.initializer && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) found = n.initializer
      if (ts.isFunctionDeclaration(n) && n.modifiers?.some(m => m.kind === ts.SyntaxKind.DefaultKeyword)) found = n
      if (ts.isExportAssignment(n) && (ts.isArrowFunction(n.expression) || ts.isFunctionExpression(n.expression))) found = n.expression
    })
    return found
  }
  request(fn: ts.FunctionLikeDeclaration, base: string, file: string, transport: string, params: string[]): string {
    const source = this.rel(file)
    const fields: Field[] = params.map(p => ({ name: p, type: 'string', note: 'path parameter' }))
    const reqName = fn.parameters[0]?.name.getText()
    if (transport === 'WS') {
      const payload = fn.parameters[1]
      const shape = payload ? this.shape(this.checker.getTypeAtLocation(payload), base + 'Payload', source) : this.unknown(base, source, 'no payload parameter declared')
      return this.box(shape, base + 'Request', source)
    }
    // Locate full body/query casts first. Otherwise collect statically observed keys.
    const pools: Record<string, Map<string, Field>> = { body: new Map(), query: new Map(), headers: new Map() }
    const casts = new Map<string, ts.Type>()
    let rawBody = false
    let multipart = false
    const seen = new Set<ts.Node>()
    const analyze = (node: ts.Node, req: string, hops: number) => {
      if (seen.has(node) || hops > 4) return
      seen.add(node)
      walk(node, n => {
        if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.expression.getText() === req) {
          if (['buffer', 'arrayBuffer'].includes(n.expression.name.text)) rawBody = true
          if (n.expression.name.text === 'multipart') multipart = true
        }
        if (ts.isElementAccessExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.expression.getText() === req && n.argumentExpression && ts.isStringLiteral(n.argumentExpression)) {
          const pool = pools[n.expression.name.text]
          if (pool) {
            const name = n.argumentExpression.text
            const shape = this.shape(this.checker.getTypeAtLocation(n), base + title(n.expression.name.text) + title(name), source)
            pool.set(name, { name, ...shape, optional: !shape.repeated && !shape.type.startsWith('map<'), note: 'Observed key access; requiredness not proven. ' + (shape.note ?? '') })
          }
        }
        if (ts.isPropertyAssignment(n) && ts.isObjectLiteralExpression(n.parent)) {
          const match = unwrap(n.initializer).getText().match(new RegExp(`^${req}\\.(body|query|headers)$`))
          const contextual = match ? this.checker.getContextualType(n.parent) : undefined
          const symbol = contextual ? this.checker.getPropertyOfType(contextual, n.name.getText()) : undefined
          const expected = symbol ? this.checker.getTypeOfSymbolAtLocation(symbol, n) : undefined
          if (match && expected && !(expected.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown))) casts.set(match[1], expected)
        }
        if (ts.isAsExpression(n) || ts.isTypeAssertionExpression(n)) {
          const match = unwrap(n.expression).getText().match(new RegExp(`^${req}\\.(body|query|headers)$`))
          if (match) casts.set(match[1], this.checker.getTypeFromTypeNode(n.type))
        }
        if (ts.isPropertyAccessExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.expression.getText() === req) {
          const pool = pools[n.expression.name.text]
          if (pool) {
            const name = n.name.text
            const shape = this.shape(this.checker.getTypeAtLocation(n), base + title(n.expression.name.text) + title(name), source)
            pool.set(name, { name, ...shape, optional: !shape.repeated && !shape.type.startsWith('map<'), note: 'Observed access; requiredness not proven. ' + (shape.note ?? '') })
          }
        }
        if (ts.isVariableDeclaration(n) && n.initializer && ts.isObjectBindingPattern(n.name)) {
          const match = unwrap(n.initializer).getText().match(new RegExp(`^${req}\\.(body|query|headers)$`))
          if (match) for (const element of n.name.elements) {
            if (element.dotDotDotToken) continue
            const name = (element.propertyName ?? element.name).getText().replace(/^['"]|['"]$/g, '')
            const shape = this.shape(this.checker.getTypeAtLocation(element), base + title(match[1]) + title(name), source)
            pools[match[1]].set(name, { name, ...shape, optional: !shape.repeated && !shape.type.startsWith('map<'), note: 'Observed destructuring; requiredness not proven. ' + (shape.note ?? '') })
          }
        }
        // Follow local/imported functions only when the request object is passed unchanged.
        if (ts.isCallExpression(n)) {
          const i = n.arguments.findIndex(a => a.getText() === req)
          if (i < 0) return
          const signature = this.checker.getResolvedSignature(n)
          const declaration = signature?.getDeclaration()
          if (declaration && (ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration) || ts.isArrowFunction(declaration) || ts.isFunctionExpression(declaration)) && declaration.body && normalized(declaration.getSourceFile().fileName).startsWith(normalized(this.root) + '/')) {
            const parameter = declaration.parameters[i]
            if (parameter && ts.isIdentifier(parameter.name)) analyze(declaration.body, parameter.name.text, hops + 1)
          }
        }
      })
    }
    if (fn.body && reqName) analyze(fn.body, reqName, 0)
    for (const key of ['body', 'query', 'headers']) {
      let type: Shape
      if (casts.has(key)) type = this.shape(casts.get(key)!, base + title(key), source)
      else if (pools[key].size) {
        const name = base + title(key)
        // Keep an escape hatch: observed keys are not an exhaustive validated schema.
        this.add({ name, fields: [...pools[key].values(), { name: '_unmodeled', type: 'google.protobuf.Struct', note: 'Unobserved/dynamic JSON keys, preserved by adapter.' }], source })
        type = { type: name }
      } else type = { type: 'google.protobuf.Struct', note: 'No exhaustive schema declared; opaque JSON object.' }
      fields.push({ name: key, ...type, optional: !type.repeated && !type.type.startsWith('map<') })
    }
    if (rawBody) fields.push({ name: 'raw_body', type: 'bytes', optional: true, note: 'Binary HTTP request payload read by req.buffer()/arrayBuffer().' })
    if (multipart) {
      if (!this.messages.has('MultipartPart')) this.add({ name: 'MultipartPart', source: 'Transport adapter representation of req.multipart()', fields: [{ name: 'name', type: 'string' }, { name: 'filename', type: 'string', optional: true }, { name: 'content_type', type: 'string', optional: true }, { name: 'data', type: 'bytes' }] })
      fields.push({ name: 'parts', type: 'MultipartPart', repeated: true, note: 'Adapter encodes these parts as HTTP multipart/form-data.' })
    }
    return this.add({ name: base + 'Request', fields, source })
  }
  response(fn: ts.FunctionLikeDeclaration, base: string, file: string): string {
    const source = this.rel(file)
    const sig = this.checker.getSignatureFromDeclaration(fn)
    const type = sig ? this.checker.getReturnTypeOfSignature(sig) : undefined
    const shape = type ? this.shape(type, base + 'Result', source) : this.unknown(base, source, 'no handler return signature')
    return this.box(shape, base + 'Response', source)
  }
  endpoint(svc: string, file: string, transport: string, route: string, params: string[], category: string) {
    const sf = this.program.getSourceFile(file)
    if (!sf) throw Error(`Source not loaded: ${file}`)
    const fn = this.handler(sf)
    if (!fn) throw Error(`Missing static handler: ${file}`)
    const serviceName = title(svc) + (transport === 'WS' ? 'Realtime' : 'Service')
    const name = title(transport + '_' + route.replaceAll(':', '_By_'))
    const base = title(svc) + name
    const request = this.request(fn, base, file, transport === 'WS' ? 'WS' : 'HTTP', params)
    const response = this.response(fn, base, file)
    const rpc: Rpc = { name, request, response, transport: (transport === 'WS' ? 'WS ' : 'HTTP ' + transport + ' ') + route, source: this.rel(file) }
    const service = this.services.get(serviceName) ?? { name: serviceName, rpcs: [] }
    if (service.rpcs.some(r => r.name === name)) throw Error(`RPC name collision: ${serviceName}.${name}`)
    service.rpcs.push(rpc)
    this.services.set(serviceName, service)
    const entry = { service: svc, method: transport, path: route, request, response, source: this.rel(file), category }
    if (transport === 'WS') this.wsEvents.push(entry)
    else this.httpRoutes.push(entry)
  }
  routes(svc: string, dir: string, category = 'api') {
    for (const file of files(dir)) {
      const name = path.basename(file)
      const m = name.match(/^(get|post|put|delete|patch|options|head)\.(ts|js)$/i)
      if (!m) { this.ignored.push({ source: this.rel(file), reason: 'filename is not a recognized HTTP verb' }); continue }
      let relative = normalized(path.relative(dir, path.dirname(file)))
      const params = [...relative.matchAll(/\[([a-zA-Z0-9_]+)\]/g)].map(m => m[1])
      if (relative.includes('[$]')) params.push('wildcard_path')
      relative = relative.replace(/\[([a-zA-Z0-9_]+)\]/g, ':$1').replace('[$]', '*').replace(/\/index$/, '')
      for (const m of relative.matchAll(/:([a-zA-Z0-9_]+)/g)) if (!params.includes(m[1])) params.push(m[1])
      this.endpoint(svc, file, m[1].toUpperCase(), '/' + relative, params, category)
    }
  }
  run() {
    for (const svc of fs.readdirSync(path.join(this.root, 'services')).sort()) {
      const base = path.join(this.root, 'services', svc)
      this.routes(svc, path.join(base, 'routes'))
      for (const file of files(path.join(base, 'ws_routes'))) this.endpoint(svc, file, 'WS', normalized(path.relative(path.join(base, 'ws_routes'), file)).split('.')[0].replaceAll('/', ':'), [], 'api')
    }
    // Emit only messages reachable from client/server request and response types.
    const needed = new Set<string>()
    const visit = (name: string) => {
      if (needed.has(name) || !this.messages.has(name)) return
      needed.add(name)
      for (const field of this.messages.get(name)!.fields) {
        const reference = field.type.startsWith('map<') ? field.type.match(/,\s*([^>]+)>$/)?.[1] : field.type
        if (reference) visit(reference)
      }
    }
    for (const svc of this.services.values()) for (const rpc of svc.rpcs) { visit(rpc.request); visit(rpc.response) }
    for (const name of this.messages.keys()) if (!needed.has(name)) this.messages.delete(name)
    return this
  }
  report() {
    const seen = new Set<string>()
    const unresolved = this.unresolved.filter(item => {
      const key = JSON.stringify(item)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    return {
      scope: 'Client-to-server API only: packages/server/services/*/{routes,ws_routes}; only reachable request/response DTOs are emitted.',
      counts: { apiHttp: this.httpRoutes.length, ws: this.wsEvents.length, messages: this.messages.size, services: this.services.size, sourceFiles: this.rootFiles.length, unresolved: unresolved.length },
      httpRoutes: this.httpRoutes, wsEvents: this.wsEvents,
      ignoredFiles: this.ignored, unresolved,
      exclusions: ['SFU IPC/server-to-server handlers', 'desktop-local API', 'web-wrapper routes', 'Linebridge built-in / and /_map', 'external /spectrum proxy', 'unreferenced persistence schemas and internal event DTOs'],
      limitations: ['No gRPC server or HTTP/WS adapter is implemented.', 'Observed request fields are not exhaustive validation schemas.', 'Unknown/dynamic values use Value/Struct; the report includes intermediate inference attempts.', 'TS number maps to double; integer semantics are not invented.', 'Heterogeneous unions, Date|string, runtime classes and tuples may use Value.', 'WS RPCs document request/reply semantics, not invented bidirectional streams. SSE and binary streaming endpoints require a transport adapter.', 'Server HTTP routes include permission-restricted handlers; listing an RPC does not grant access.'],
      sources: this.rootFiles.map(f => this.rel(f)),
    }
  }
}
