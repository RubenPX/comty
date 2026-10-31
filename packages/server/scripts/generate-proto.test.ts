import { test, expect } from 'bun:test'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { spawnSync } from 'node:child_process'

test('CLI check is read-only and generation persists the tag manifest', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'comty-proto-test-'))
  const server = path.join(directory, 'server')
  fs.mkdirSync(path.join(server, 'services'), { recursive: true })
  fs.mkdirSync(path.join(server, 'db_models', 'sample'), { recursive: true })
  fs.writeFileSync(path.join(server, 'tsconfig.json'), '{}')
  fs.writeFileSync(path.join(server, 'db_models/sample/index.ts'), 'defineModel({name:"Sample",schema:{alpha:{type:String},beta:{type:Boolean}}})')
  const output = path.join(directory, 'comty.proto')
  const run = (check = false) => spawnSync(process.execPath, [path.join(import.meta.dirname, 'generate-proto.ts'), '--server-root', server, '--out', output, ...(check ? ['--check'] : [])], { encoding: 'utf8' })
  try {
    expect(run(true).status).not.toBe(0)
    expect(fs.existsSync(output)).toBe(false)
    expect(run().status).toBe(0)
    expect(fs.existsSync(path.join(directory, 'comty.tags.json'))).toBe(true)
    expect(run(true).status).toBe(0)
    const before = fs.readFileSync(path.join(directory, 'comty.tags.json'), 'utf8')
    expect(run().status).toBe(0)
    expect(fs.readFileSync(path.join(directory, 'comty.tags.json'), 'utf8')).toBe(before)
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
}, 60000)
import { generate, render } from './generate-proto'
import type { Message } from './generate-proto'

test('protobuf tags survive field reordering and removed tags are reserved', () => {
  const registry = {}
  const initial: Message[] = [{ name: 'TestRecord', source: 'fixture', fields: [{ name: 'alpha', type: 'string' }, { name: 'beta', type: 'bool' }] }]
  render(initial, [], registry)
  const updated: Message[] = [{ name: 'TestRecord', source: 'fixture', fields: [{ name: 'gamma', type: 'string' }, { name: 'beta', type: 'bool' }] }]
  const text = render(updated, [], registry)
  expect(text.includes('bool beta = 2;')).toBe(true)
  expect(text.includes('string gamma = 3;')).toBe(true)
  expect(text.includes('reserved 1;')).toBe(true)
})
test('field names that match Object.prototype still get real tags', () => {
  const text = render([{ name: 'RecordWithConstructor', source: 'fixture', fields: [{ name: 'constructor', type: 'string' }] }])
  expect(text.includes('string constructor = 1;')).toBe(true)
})

test('wire-incompatible field changes are rejected', () => {
  const registry = {}
  render([{ name: 'Versioned', source: 'fixture', fields: [{ name: 'value', type: 'string' }] }], [], registry)
  expect(() => render([{ name: 'Versioned', source: 'fixture', fields: [{ name: 'value', type: 'bool' }] }], [], registry)).toThrow('Incompatible protobuf field type')
})

test('transport mapping and original JSON keys survive in compiled descriptors', () => {
  const text = render([{ name: 'Headers', source: 'fixture', fields: [{ name: 'uploader-file-id', type: 'string' }] }], [{ name: 'UploadService', rpcs: [{ name: 'Upload', request: 'Headers', response: 'Headers', source: 'fixture', transport: 'HTTP POST /upload' }] }])
  expect(text.includes('json_name = "uploader-file-id"')).toBe(true)
  expect(text.includes('option (http_method) = "POST";')).toBe(true)
  expect(text.includes('option (http_path) = "/upload";')).toBe(true)
})

const root = path.join(import.meta.dirname, '..')

test('only client-facing server routes and their DTOs are emitted', () => {
  const result = generate(root)
  expect(result.proto.includes('service SfuIpcService')).toBe(false)
  expect(result.proto.includes('service LinebridgeInfrastructureService')).toBe(false)
  expect(result.proto.includes('service DesktopLocalService')).toBe(false)
  expect(result.proto.includes('service WrapperService')).toBe(false)
  expect(result.proto.includes('message DbUser')).toBe(false)
  expect(result.proto.includes('message ScyllaGroups')).toBe(false)
  expect(result.proto.includes('ipc_event')).toBe(false)
  expect(result.report.httpRoutes).toHaveLength(180)
  expect(result.report.wsEvents).toHaveLength(37)
}, 60000)
test('server request DTOs contain typed payloads and preserve unknown JSON', () => {
  const result = generate(root)
  expect(result.proto).toContain('service AuthService')
  expect(result.proto).toContain('HTTP POST /auth')
  expect(result.proto).toContain('WS channel:send')
  expect(result.proto).toMatch(/repeated string add_roles = \d+(?: \[.*\])?;/)
  expect((result.report as any).httpRoutes).toHaveLength(180)
  expect((result.report as any).wsEvents).toHaveLength(37)
  expect(result.proto.includes('json_name = "uploader-file-id"')).toBe(true)
  expect(result.proto.includes('bytes raw_body')).toBe(true)
  const login = result.proto.match(/message AuthPOSTAuthBody \{([^}]+)\}/)?.[1] ?? ''
  expect(login.includes('string password')).toBe(true)
  expect(login.includes('string mfa_code')).toBe(true)
}, 60000)
