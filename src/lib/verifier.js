import Compiler from './compiler'
import linker from './linker'
import { getHash } from './utils'
import { add0x } from '@rsksmart/rsk-utils'
import { isValidMetadata, searchMetadata } from './solidityMetadata'
import { decodeConstructorArgs, encodeConstructorArgs } from './constructor'
import { remove0x } from '@rsksmart/rsk-utils/dist/strings'

const SEVERITY_WARNING = 'warning'

export function Verifier (options = {}) {
  const compiler = Compiler(options)

  const verify = async (payload = {}, { resolveImports } = {}) => {
    try {
      if (payload.bytecode) payload.bytecode = add0x(payload.bytecode)
      const { version, imports, bytecode, source, libraries, name, constructorArguments, encodedConstructorArguments } = payload
      if (!name) throw new Error('Invalid contract name')
      if (!bytecode) throw new Error(`Invalid bytecode`)
      const KEY = name
      resolveImports = resolveImports || compiler.getImports(imports)
      const settings = payload.settings || {}
      let sources = {}
      const usedSources = []

      // wraps resolveImports method to catch used sources
      const updateUsedSources = (path) => {
        let file = path.split('/').pop()
        const { contents } = resolveImports(path)
        const hash = (contents) ? getHash(contents) : null
        usedSources.push({ path, file, hash })
        return resolveImports(path)
      }

      sources[KEY] = { content: source }
      const input = compiler.createInput({ sources, settings })

      const result = await compiler.compile(input, { version, resolveImports: updateUsedSources })
      const { contracts } = result
      const { errors, warnings } = filterResultErrors(result)
      if (errors) return { errors, warnings }

      if (!contracts || !contracts[KEY]) throw new Error('Empty compilation result')
      const compiled = contracts[KEY][name]
      const { evm, abi } = compiled
      const vargs = { contractName: KEY, bytecode, evm, libraries, constructorArguments, encodedConstructorArguments, abi }
      const { resultBytecode, orgBytecode, usedLibraries, decodedMetadata } = verifyResults(vargs)
      if (!resultBytecode) throw new Error('Invalid result ')
      const resultBytecodeHash = getHash(resultBytecode)
      const bytecodeHash = getHash(orgBytecode)

      const opcodes = evm.bytecode.opcodes
      const methodIdentifiers = Object.entries(evm.methodIdentifiers || {})
      const usedSettings = resultSettings(compiled)
      return {
        name,
        usedSettings,
        usedLibraries,
        bytecode,
        resultBytecode,
        bytecodeHash,
        resultBytecodeHash,
        abi,
        opcodes,
        usedSources,
        methodIdentifiers,
        warnings,
        decodedMetadata
      }
    } catch (err) {
      return Promise.reject(err)
    }
  }

  return Object.freeze({ verify, hash: getHash })
}

export function filterResultErrors ({ errors }) {
  let warnings
  if (errors) {
    warnings = errors.filter(e => e.severity === SEVERITY_WARNING)
    errors = errors.filter(e => e.severity !== SEVERITY_WARNING)
    errors = (errors.length) ? errors : undefined
  }
  return { errors, warnings }
}

export function parseConstructorArguments ({ constructorArguments, encodedConstructorArguments, abi }) {
  let encoded, decoded
  if (abi && (encodeConstructorArgs || constructorArguments)) {
    if (encodedConstructorArguments) {
      encoded = encodedConstructorArguments
      decoded = decodeConstructorArgs(encodedConstructorArguments, abi)
    }
    if (!encoded && constructorArguments) encoded = encodeConstructorArgs(constructorArguments, abi)
    if (!decoded && encoded) decoded = decodeConstructorArgs(encoded, abi)
  }
  return { encoded, decoded }
}

export function verifyResults (payload) {
  const { contractName, bytecode, evm, libraries } = payload
  const { decoded: constructorArguments, encoded: encodedConstructorArguments } = parseConstructorArguments(payload)
  const metadataList = searchMetadata(bytecode)

  let evmBytecode = evm.bytecode.object
  const { usedLibraries, linkLibraries } = parseLibraries(libraries, evmBytecode, contractName)

  if (Object.keys(linkLibraries).length > 0) {
    evmBytecode = linker.link(evmBytecode, linkLibraries)
  }

  const resultMetadataList = searchMetadata(evmBytecode)

  /*   if (metadataList.length !== resultMetadataList.length) {
      throw new Error('invalid metadata list length')
    } */

  let decodedMetadata = metadataList.map(m => isValidMetadata(m))
  for (let i in metadataList) {
    if (decodedMetadata[i] && resultMetadataList[i].length === metadataList[i].length && isValidMetadata(metadataList[i])) {
      resultMetadataList[i] = metadataList[i]
    }
  }

  // Add constructor args to bytecode
  if (encodedConstructorArguments) resultMetadataList.push(remove0x(encodedConstructorArguments))

  const resultBytecode = add0x(resultMetadataList.join(''))
  decodedMetadata = decodedMetadata.filter(m => m)
  const orgBytecode = add0x(bytecode)
  return { resultBytecode, orgBytecode, usedLibraries, decodedMetadata, encodedConstructorArguments, constructorArguments }
}

export function removeLibraryPrefix (lib) {
  const [prefix, name] = lib.split(':')
  return (prefix && name) ? name : lib
}

export function getLibrariesPlaceHolders (libraries, prefix) {
  const placeholders = {}

  const addLibraryPlaceHolder = (name, address, key) => {
    let library = linker.libraryHashPlaceholder(key)
    placeholders[library] = { name, address, library }
  }

  for (let name in libraries) {
    let address = libraries[name]
    addLibraryPlaceHolder(name, address, name)
    addLibraryPlaceHolder(name, address, `${prefix}:${name}`)
  }
  return placeholders
}

export function findLibrary (key, prefix, libraries) {
  if (typeof libraries !== 'object') throw new Error('Libraries must be an object')
  let name = removeLibraryPrefix(key)
  let address = libraries[name]
  let library = key
  if (!address) {
    let placeholders = getLibrariesPlaceHolders(libraries, prefix)
    if (placeholders[key]) return placeholders[key]
  }
  return { address, library, name }
}

export function parseLibraries (libraries, bytecode, prefix) {
  const bytecodeLibs = linker.find(bytecode)
  const libs = []
  for (let key in bytecodeLibs) {
    libs.push(findLibrary(key, prefix, libraries))
  }
  let linkLibraries = libs.reduce((v, a) => {
    let { address, library } = a
    if (address) v[library] = address
    return v
  }, {})
  let usedLibraries = libs.reduce((v, a, i) => {
    let { name, library, address } = a
    v[name || library || i] = address
    return v
  }, {})
  return { usedLibraries, linkLibraries }
}

export function resultSettings (compiled) {
  const { compiler, language, settings } = JSON.parse(compiled.metadata)
  const { evmVersion, libraries, optimizer, remappings } = settings
  return { compiler, language, evmVersion, libraries, optimizer, remappings }
}

export default Verifier
