#!/usr/bin/env node
/**
 * Plugin signing utility: keygen and sign.
 *
 * keygen --out <file>  - generate a keypair, print keyId + public key, write private PEM
 * sign <dir>           - sign a plugin directory using CODEBURN_SIGNING_KEY env var
 */

import { createPrivateKey, createPublicKey, randomBytes } from 'crypto'
import { readdir, readFile, stat, writeFile } from 'fs/promises'
import { join } from 'path'
import process from 'process'

const command = process.argv[2]

if (command === 'keygen') {
  await handleKeygen()
} else if (command === 'sign') {
  await handleSign()
} else {
  console.error('Usage: node scripts/sign-plugin.mjs keygen --out <file>')
  console.error('       node scripts/sign-plugin.mjs sign <dir>')
  process.exit(1)
}

async function handleKeygen() {
  const outIdx = process.argv.indexOf('--out')
  if (outIdx < 0 || outIdx + 1 >= process.argv.length) {
    console.error('Usage: node scripts/sign-plugin.mjs keygen --out <file>')
    process.exit(1)
  }
  const outFile = process.argv[outIdx + 1]

  // Generate a new keypair
  const { generateKeyPairSync } = await import('crypto')
  const { privateKey: privKeyObj, publicKey: pubKeyObj } = generateKeyPairSync('ed25519')

  // Export keys in appropriate formats
  const privateKeyPem = privKeyObj.export({ format: 'pem', type: 'pkcs8' })
  const publicKeyPem = pubKeyObj.export({ format: 'pem', type: 'spki' })

  // Base64 encode the PEM public key for storage
  const pubKeyBase64 = Buffer.from(publicKeyPem).toString('base64')

  // Generate keyId as 8 hex chars from random bytes
  const keyIdBytes = randomBytes(4)
  const keyId = keyIdBytes.toString('hex').substring(0, 8)

  // Write private key PEM to file
  await writeFile(outFile, privateKeyPem, 'utf8')

  // Print to stdout
  console.log(`keyId: ${keyId}`)
  console.log(`public: ${pubKeyBase64}`)
}

async function handleSign() {
  const pluginDir = process.argv[3]
  if (!pluginDir) {
    console.error('Usage: node scripts/sign-plugin.mjs sign <dir>')
    process.exit(1)
  }

  const sigKeyPath = process.env.CODEBURN_SIGNING_KEY
  if (!sigKeyPath) {
    console.error('CODEBURN_SIGNING_KEY not set')
    process.exit(1)
  }

  // Read the plugin manifest
  const manifestFile = join(pluginDir, 'codeburn-plugin.json')
  const manifestRaw = JSON.parse(await readFile(manifestFile, 'utf8'))
  const { name, version } = manifestRaw
  if (!name || !version) {
    console.error('Plugin manifest missing name or version')
    process.exit(1)
  }

  // Get file list: all regular files except codeburn-plugin.sig
  const files = await getFilesList(pluginDir)

  // Build the canonical signing digest
  const digest = computeDigest(name, version, files)

  // Read private key and sign
  const { sign } = await import('crypto')
  const privKeyPem = await readFile(sigKeyPath, 'utf8')
  const privKey = createPrivateKey(privKeyPem)
  const signature = sign(null, Buffer.from(digest), privKey)
  const signatureBase64 = signature.toString('base64')

  // Extract keyId from the public key derived from the private key
  const pubKey = createPublicKey(privKey)
  const pubKeyPem = pubKey.export({ format: 'pem', type: 'spki' })
  // Hash the PEM to get a consistent keyId
  const { createHash } = await import('crypto')
  const keyIdBytes = createHash('sha256').update(pubKeyPem).digest().slice(0, 4)
  const keyId = keyIdBytes.toString('hex')

  // Write signature file
  const sigFile = join(pluginDir, 'codeburn-plugin.sig')
  const sigData = {
    alg: 'ed25519',
    keyId,
    signature: signatureBase64,
  }
  await writeFile(sigFile, JSON.stringify(sigData), 'utf8')
  console.log(`Signed ${pluginDir}`)
}

async function getFilesList(dir) {
  const files = []
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isFile() && entry.name !== 'codeburn-plugin.sig') {
      const fullPath = join(dir, entry.name)
      const stat_info = await stat(fullPath)
      if (!stat_info.isFile()) continue
      const content = await readFile(fullPath)
      const sha256 = await hashSha256(content)
      files.push({ path: entry.name, sha256 })
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path))
  return files
}

function computeDigest(name, version, files) {
  const canonical = JSON.stringify({ name, version, files })
  return canonical
}

async function hashSha256(data) {
  const crypto = await import('crypto')
  return crypto.createHash('sha256').update(data).digest('hex')
}
