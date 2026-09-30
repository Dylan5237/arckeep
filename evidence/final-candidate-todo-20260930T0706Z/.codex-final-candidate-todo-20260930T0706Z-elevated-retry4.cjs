'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { app } = require('electron')
const profileRoot = process.env.ARCKEEP_PROFILE_ROOT
if (!profileRoot || !path.isAbsolute(profileRoot)) throw new Error('ARCKEEP_PROFILE_ROOT must be absolute')
const appData = path.join(profileRoot, 'appdata')
fs.mkdirSync(appData, { recursive: true })
app.setPath('appData', appData)
process.env.ARCKEEP_WRAPPER_APPDATA_APPLIED = '1'
import(pathToFileURL(path.join(__dirname, 'out', 'main', 'index.js')).href).catch(error => {
  console.error(error)
  app.exit(1)
})
