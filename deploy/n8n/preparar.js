// Roda a cada inicio do container (Render): prepara o banco, o admin e as credenciais do n8n.
// Tudo idempotente. Usa o driver "pg" que ja vem dentro da imagem do n8n.
const fs = require('fs')
const path = require('path')

const pnpm = '/usr/local/lib/node_modules/n8n/node_modules/.pnpm'
const pastaPg = fs.readdirSync(pnpm).find(d => /^pg@\d/.test(d))
const { Client } = require(path.join(pnpm, pastaPg, 'node_modules', 'pg'))

const env = process.env

// modo --env: o Render entrega o banco como URL (BANCO_URL); o n8n quer as partes separadas
if (process.argv.includes('--env')) {
  const u = new URL(env.BANCO_URL)
  const q = v => `'${String(v).replace(/'/g, `'\\''`)}'`
  console.log([
    `export DB_POSTGRESDB_HOST=${q(u.hostname)}`,
    `export DB_POSTGRESDB_PORT=${q(u.port || 5432)}`,
    `export DB_POSTGRESDB_DATABASE=${q(decodeURIComponent(u.pathname.slice(1)))}`,
    `export DB_POSTGRESDB_USER=${q(decodeURIComponent(u.username))}`,
    `export DB_POSTGRESDB_PASSWORD=${q(decodeURIComponent(u.password))}`,
  ].join('\n'))
  process.exit(0)
}

const ssl = /^(1|true)$/i.test(env.DB_POSTGRESDB_SSL_ENABLED || '') ? { rejectUnauthorized: false } : false

function exigir(nome) {
  if (!env[nome]) { console.error(`[ia-central] falta a variavel ${nome}`); process.exit(1) }
  return env[nome]
}

async function main() {
  const db = new Client({
    host: exigir('DB_POSTGRESDB_HOST'), port: +(env.DB_POSTGRESDB_PORT || 5432),
    database: exigir('DB_POSTGRESDB_DATABASE'), user: exigir('DB_POSTGRESDB_USER'),
    password: exigir('DB_POSTGRESDB_PASSWORD'), ssl,
  })
  await db.connect()

  // modo --ativar: depois do import, publica os workflows (igual ao "Publish" do editor)
  if (process.argv.includes('--ativar')) {
    const ids = fs.readdirSync('/opt/ia/workflows').filter(f => f.endsWith('.json'))
      .map(f => JSON.parse(fs.readFileSync(path.join('/opt/ia/workflows', f), 'utf8')))
      .filter(w => w.id && w.active).map(w => w.id)
    const r = await db.query('UPDATE workflow_entity SET active = true, "activeVersionId" = "versionId" WHERE id = ANY($1) RETURNING id', [ids])
    console.log(`[ia-central] ${r.rowCount} workflows ativados`)
    await db.end()
    return
  }

  // 1) tabelas e funcoes da IA (00-bancos.sql e so para o Docker local)
  const pasta = '/opt/ia/db'
  for (const arq of fs.readdirSync(pasta).filter(f => f.endsWith('.sql') && !f.startsWith('00-')).sort()) {
    await db.query(fs.readFileSync(path.join(pasta, arq), 'utf8'))
    console.log(`[ia-central] banco: ${arq} ok`)
  }

  // 2) admin maximo (cria ou atualiza a senha a partir das variaveis)
  if (env.ADMIN_LOGIN && env.ADMIN_SENHA) {
    await db.query("SELECT nucleo.salvar_usuario($1, $2, $3, 'admin')", [env.ADMIN_NOME || 'Admin', env.ADMIN_LOGIN, env.ADMIN_SENHA])
    console.log(`[ia-central] admin '${env.ADMIN_LOGIN}' pronto`)
  } else {
    console.warn('[ia-central] ADMIN_LOGIN/ADMIN_SENHA vazios: nenhum admin criado')
  }
  await db.end()

  // 3) credenciais do n8n (arquivo temporario, apagado depois do import)
  const cred = [
    { id: 'pgNucleo01', name: 'Postgres Nucleo', type: 'postgres', data: {
      host: env.DB_POSTGRESDB_HOST, port: +(env.DB_POSTGRESDB_PORT || 5432), database: env.DB_POSTGRESDB_DATABASE,
      user: env.DB_POSTGRESDB_USER, password: env.DB_POSTGRESDB_PASSWORD,
      ssl: ssl ? 'require' : 'disable', allowUnauthorizedCerts: !!ssl, sshTunnel: false } },
    { id: 'openai01', name: 'OpenAI', type: 'openAiApi', data: { apiKey: env.OPENAI_API_KEY || '' } },
    { id: 'anthropic01', name: 'Anthropic', type: 'anthropicApi', data: { apiKey: env.ANTHROPIC_API_KEY || '' } },
  ]
  fs.writeFileSync('/tmp/credenciais.json', JSON.stringify(cred), { mode: 0o600 })
  console.log('[ia-central] credenciais geradas')
}

main().catch(e => { console.error('[ia-central] falhou ao preparar:', e.message); process.exit(1) })
