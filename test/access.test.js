/**
 * `/query-tide` 访问控制的回归测试。
 * 该路由会吐出账户余额, 所以这里的每条断言都对应一种“别人能读到我的余额”的场景。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { isRequestAllowed } from '../src/index.js'

test('本机来源放行', () => {
  for (const host of ['localhost:3000', 'localhost', '127.0.0.1:8080', '[::1]:8080']) {
    assert.equal(isRequestAllowed({ host }), true, host)
  }
})

test('局域网 IP 直连放行(手机上开着 dsh web 的正常用法)', () => {
  assert.equal(isRequestAllowed({ host: '192.168.1.7:3000' }), true)
  assert.equal(isRequestAllowed({ host: '10.0.0.2:3000' }), true)
})

test('同源请求放行', () => {
  assert.equal(isRequestAllowed({ host: 'localhost:3000', origin: 'http://localhost:3000' }), true)
  assert.equal(isRequestAllowed({ host: '192.168.1.7:3000', origin: 'http://192.168.1.7:3000' }), true)
})

test('跨源网页读不到余额', () => {
  // 同机不同端口同样是跨源。
  for (const origin of ['https://evil.example', 'http://localhost:3001', 'http://127.0.0.1:3000']) {
    assert.equal(isRequestAllowed({ host: 'localhost:3000', origin }), 'origin-not-allowed', origin)
  }
})

test('沙箱 iframe / file:// 的 null 来源被拒', () => {
  assert.equal(isRequestAllowed({ host: 'localhost:3000', origin: 'null' }), 'origin-not-allowed')
})

test('DNS rebinding 被 Host 校验挡下', () => {
  // 攻击手法: 攻击者域名解析到 127.0.0.1, 但 Host 头仍是那个域名。
  assert.equal(isRequestAllowed({ host: 'rebind.evil.example:3000' }), 'host-not-allowed')
  assert.equal(isRequestAllowed({ host: 'rebind.evil.example' }), 'host-not-allowed')
})

test('allowedHosts 放行自建域名反代', () => {
  const allowed = ['dsh.mylan.internal']
  assert.equal(isRequestAllowed({ host: 'dsh.mylan.internal:8443' }, allowed), true)
  assert.equal(isRequestAllowed({ host: 'DSH.MyLan.Internal' }, allowed), true)
  assert.equal(
    isRequestAllowed({ host: 'dsh.mylan.internal', origin: 'https://dsh.mylan.internal' }, allowed),
    true,
  )
  // 登记了域名也不等于放行跨源读取。
  assert.equal(
    isRequestAllowed({ host: 'dsh.mylan.internal', origin: 'https://evil.example' }, allowed),
    'origin-not-allowed',
  )
  // 未登记的邻居域名依然被拒。
  assert.equal(isRequestAllowed({ host: 'other.mylan.internal' }, allowed), 'host-not-allowed')
})

test('缺失或畸形 Host 一律拒绝', () => {
  assert.equal(isRequestAllowed({}), 'missing-host')
  assert.equal(isRequestAllowed({ host: '' }), 'missing-host')
  assert.equal(isRequestAllowed({ host: undefined }), 'missing-host')
})

test('畸形 Origin 不会因解析异常而放行', () => {
  assert.equal(isRequestAllowed({ host: 'localhost:3000', origin: 'not a url' }), 'origin-not-allowed')
  assert.equal(isRequestAllowed({ host: 'localhost:3000', origin: '://' }), 'origin-not-allowed')
})

test('allowedHosts 中的非字符串项不会导致崩溃或误放行', () => {
  assert.equal(isRequestAllowed({ host: 'evil.example' }, [null, 42, undefined]), 'host-not-allowed')
})
