const { execSync } = require('child_process')
const path = require('path')

exports.default = async function sign(configuration) {
  const filePath = configuration.path

  if (!filePath.endsWith('.exe') && !filePath.endsWith('.msi')) {
    return
  }

  const certPath = path.resolve(__dirname, '..', 'certs', 'certum-code-signing.pem')
  const pkcs11Module = '/usr/local/lib/libSimplySignPKCS.dylib'
  const pkcs11Engine = '/opt/homebrew/lib/engines-3/pkcs11.dylib'
  const timestampUrl = 'http://time.certum.pl'

  const keyId = 'pkcs11:model=SimplySign%20C;manufacturer=CERTUM;token=Code%20Signing;type=private'

  const tmpOutput = filePath + '.signed'

  const command = [
    'osslsigncode sign',
    `-pkcs11engine "${pkcs11Engine}"`,
    `-pkcs11module "${pkcs11Module}"`,
    `-certs "${certPath}"`,
    `-key "${keyId}"`,
    '-h sha256',
    `-ts "${timestampUrl}"`,
    `-in "${filePath}"`,
    `-out "${tmpOutput}"`,
  ].join(' ')

  console.log(`[sign] Signing: ${path.basename(filePath)}`)

  try {
    execSync(command, { stdio: 'inherit', timeout: 120_000 })
  } catch (error) {
    throw new Error(
      `[sign] Failed to sign ${path.basename(filePath)}.\n` +
      'Make sure SimplySign Desktop is connected to the cloud.\n' +
      error.message
    )
  }

  const fs = require('fs')
  fs.renameSync(tmpOutput, filePath)

  console.log(`[sign] Signed successfully: ${path.basename(filePath)}`)
}
