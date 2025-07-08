/**
 * kubernetes-types-generator
 *
 * Generates TypeScript types for Kubernetes API resources from OpenAPI specifications.
 * This tool fetches Kubernetes API schemas and converts them into well-typed TypeScript definitions.
 */

import {readFileSync, writeFileSync, mkdirSync} from 'fs'
import * as path from 'path'
import {
  Project,
  PropertySignatureStructure,
  ScriptTarget,
  SourceFile,
  StructureKind,
} from 'ts-morph'

// ============================================================================
// OpenAPI Type Definitions
// ============================================================================

/** Root OpenAPI specification structure */
export interface API {
  info: APIInfo
  definitions: Record<string, Definition>
}

/** API metadata information */
export interface APIInfo {
  title: string
  version: string
}

/** OpenAPI definition for a type */
export interface Definition {
  description: string
  required?: string[]
  properties?: Record<string, Property>
  'x-kubernetes-group-version-kind'?: GroupVersionKind[]
}

/** Kubernetes group, version, and kind information */
export interface GroupVersionKind {
  group: string
  version: string
  kind: string
}

/** Base property metadata */
export interface PropertyMeta {
  description: string
}

/** Property definition combining metadata with value type */
export type Property = PropertyMeta & Value

/** Union of all possible value types in OpenAPI */
export type Value = ScalarValue | ArrayValue | ObjectValue | Reference

/** Reference to another definition */
export interface Reference {
  $ref: string
}

/** Scalar value types */
export interface ScalarValue {
  type: 'string' | 'integer' | 'number' | 'boolean'
}

/** Array value type */
export interface ArrayValue {
  type: 'array'
  items: Value
}

/** Object value type with additional properties */
export interface ObjectValue {
  type: 'object'
  additionalProperties: Value
}

// ============================================================================
// Constants and Configuration
// ============================================================================

/** Definition name prefixes to simplify */
const DEFINITION_SIMPLIFICATIONS = {
  'io.k8s.api.': '',
  'io.k8s.apimachinery.pkg.apis.': '',
  'io.k8s.apimachinery.pkg.': '',
  'io.k8s.apiextensions-apiserver.pkg.apis.': '',
} as const

/** Types that should be elided (replaced with their mapped types) */
const ELIDED_TYPES: Record<string, string> = {
  IntOrString: 'number | string',
} as const

/** Types that should be treated as scalar types with specific mappings */
const SCALAR_TYPES: Record<string, string> = {
  Quantity: 'string',
  Time: 'string',
  MicroTime: 'string',
  JSONSchemaPropsOrArray: 'JSONSchemaProps | JSONSchemaProps[]',
  JSONSchemaPropsOrBool: 'JSONSchemaProps | boolean',
  JSONSchemaPropsOrStringArray: 'JSONSchemaProps | string[]',
} as const

/** OpenAPI reference prefix */
const OPENAPI_REF_PREFIX = '#/definitions/' as const

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Resolves a $ref reference to its definition
 * @param api The OpenAPI specification
 * @param reference The reference object to resolve
 * @returns The resolved definition name and definition object
 * @throws Error if the reference is invalid or cannot be resolved
 */
export const resolve = (api: API, {$ref: ref}: Reference): {name: string; def: Definition} => {
  if (!ref.startsWith(OPENAPI_REF_PREFIX)) {
    throw new Error(`Invalid or unsupported $ref: ${JSON.stringify(ref)}`)
  }

  const name = ref.slice(OPENAPI_REF_PREFIX.length)
  const def = api.definitions[name]

  if (!def) {
    throw new Error(`Failed to resolve ${name} in ${api.info.title}/${api.info.version}`)
  }

  return {name, def}
}

/**
 * Simplifies a definition name by removing common Kubernetes prefixes
 * @param name The original definition name
 * @returns The simplified name or undefined if no simplification applies
 */
const simplifyDefinitionName = (name: string): string | undefined => {
  for (const [prefix, replacement] of Object.entries(DEFINITION_SIMPLIFICATIONS)) {
    if (name.startsWith(prefix)) {
      return `${replacement}${name.slice(prefix.length)}`
    }
  }
  return undefined
}

/**
 * Parses a definition name into its component parts
 * @param name The definition name to parse
 * @returns Object with parsed name and path, or undefined if unparseable
 */
export function parseDefinitionName(name: string): {name: string; path: string} | undefined {
  const simplifiedName = simplifyDefinitionName(name)
  if (!simplifiedName) {
    return undefined
  }

  const parts = simplifiedName.split('.')
  const typeName = parts[parts.length - 1]!
  const importPath = parts.slice(0, -1).join('/')

  return {name: typeName, path: importPath}
}

/**
 * Normalizes a Kubernetes version string
 * @param version The version string to normalize
 * @returns The normalized version string
 */
function normalizeVersion(version: string): string {
  let normalizedVersion = version

  // Add 'v' prefix if missing
  if (/^\d/.test(normalizedVersion)) {
    normalizedVersion = `v${normalizedVersion}`
  }

  // Add patch version if missing
  if (/^v\d+\.\d+$/.test(normalizedVersion)) {
    normalizedVersion = `${normalizedVersion}.0`
  }

  return normalizedVersion
}

/**
 * Generates the file path for a given import path
 * @param importPath The import path
 * @returns The TypeScript file path
 */
export const generateFilePath = (importPath: string): string => `${importPath}.ts`

/**
 * Type guard for exhaustive type checking
 * @param value The value that should never be reached
 * @throws Error indicating unreachable code
 */
const assertNever = (value: never): never => {
  throw new Error(`Unreachable code was reached with value: ${JSON.stringify(value)}`)
}

// ============================================================================
// Import Management
// ============================================================================

/**
 * Manages imports for a TypeScript source file
 */
export class ImportManager {
  private readonly imports = new Map<SourceFile, Set<string>>()

  constructor(private readonly sourceFile: SourceFile) {}

  /**
   * Adds an import from another source file
   * @param fromFile The source file to import from
   * @param importName The name to import
   * @returns This instance for method chaining
   */
  public addImport(fromFile: SourceFile, importName: string): this {
    // Don't import from self
    if (fromFile === this.sourceFile) {
      return this
    }

    let fileImports = this.imports.get(fromFile)
    if (!fileImports) {
      fileImports = new Set()
      this.imports.set(fromFile, fileImports)
    }

    fileImports.add(importName)
    return this
  }

  /**
   * Applies all accumulated imports to the source file
   */
  public applyImports(): void {
    for (const [fromFile, importNames] of this.imports) {
      const relativePath = this.sourceFile
        .getDirectory()
        .getRelativePathAsModuleSpecifierTo(fromFile)

      this.sourceFile.addImportDeclaration({
        moduleSpecifier: relativePath,
        namedImports: [...importNames].sort(),
      })
    }
  }
}

/**
 * Ensures a source file exists in the project
 * @param project The TypeScript project
 * @param filePath The path of the file to ensure
 * @returns The source file instance
 */
export const ensureSourceFile = (project: Project, filePath: string): SourceFile => {
  return project.getSourceFile(filePath) ?? project.createSourceFile(filePath)
}

// ============================================================================
// Type Generation
// ============================================================================

/** Resolved definition with metadata */
interface ResolvedDefinition {
  name: string
  path: string
  def: Definition
}

/**
 * Extracts and resolves all definitions from an API specification
 * @param api The OpenAPI specification
 * @returns Array of resolved definitions
 */
export function extractDefinitions(api: API): ResolvedDefinition[] {
  const definitions: ResolvedDefinition[] = []

  for (const definitionName of Object.keys(api.definitions)) {
    const parsed = parseDefinitionName(definitionName)
    if (parsed) {
      definitions.push({
        ...parsed,
        def: api.definitions[definitionName]!,
      })
    }
  }

  return definitions
}

/**
 * Generates property signatures for a TypeScript interface
 * @param project The TypeScript project
 * @param api The OpenAPI specification
 * @param definition The definition to generate properties for
 * @param importManager The import manager for handling imports
 * @returns Array of property signature structures
 */
export function generateProperties(
  project: Project,
  api: API,
  {required, properties: props, 'x-kubernetes-group-version-kind': gvk}: Definition,
  importManager: ImportManager
): PropertySignatureStructure[] {
  if (!props) {
    return []
  }

  return Object.entries(props).map(([propertyName, property]) => {
    const propertyType =
      generateKindType(gvk, propertyName) ||
      generateTypeString(project, api, importManager, property)

    return {
      name: propertyName,
      kind: StructureKind.PropertySignature,
      type: propertyType,
      docs: property.description ? [property.description] : [],
      hasQuestionToken: !(required ?? []).includes(propertyName),
      isReadonly: property.description?.includes('Read-only.') ?? false,
    }
  })
}

/**
 * Generates special type strings for Kubernetes kind and apiVersion properties
 * @param gvkList The GroupVersionKind list
 * @param propertyName The property name
 * @returns The generated type string or undefined
 */
export function generateKindType(
  gvkList: GroupVersionKind[] | undefined,
  propertyName: string
): string | undefined {
  if (gvkList?.length === 1) {
    const [gvk] = gvkList

    if (gvk && propertyName === 'apiVersion') {
      const apiVersion = [gvk.group, gvk.version].filter(Boolean).join('/')
      return JSON.stringify(apiVersion)
    }

    if (gvk && propertyName === 'kind') {
      return JSON.stringify(gvk.kind)
    }
  }

  return undefined
}

/**
 * Generates a TypeScript type string from an OpenAPI value
 * @param project The TypeScript project
 * @param api The OpenAPI specification
 * @param importManager The import manager
 * @param value The value to generate a type for
 * @returns The TypeScript type string
 */
export function generateTypeString(
  project: Project,
  api: API,
  importManager: ImportManager,
  value: Value
): string {
  if ('$ref' in value) {
    return handleReferenceType(project, api, importManager, value)
  }

  if ('type' in value) {
    return handleValueType(project, api, importManager, value)
  }

  return assertNever(value)
}

/**
 * Handles reference types in type generation
 * @param project The TypeScript project
 * @param api The OpenAPI specification
 * @param importManager The import manager
 * @param reference The reference value
 * @returns The TypeScript type string
 */
function handleReferenceType(
  project: Project,
  api: API,
  importManager: ImportManager,
  reference: Reference
): string {
  const {name} = resolve(api, reference)
  const parsedRef = parseDefinitionName(name)

  if (!parsedRef) {
    throw new Error(`Value references excluded type: ${JSON.stringify(reference)}`)
  }

  if (parsedRef.name in ELIDED_TYPES) {
    return ELIDED_TYPES[parsedRef.name]!
  }

  importManager.addImport(
    ensureSourceFile(project, generateFilePath(parsedRef.path)),
    parsedRef.name
  )

  return parsedRef.name
}

/**
 * Handles value types in type generation
 * @param project The TypeScript project
 * @param api The OpenAPI specification
 * @param importManager The import manager
 * @param value The value type
 * @returns The TypeScript type string
 */
function handleValueType(
  project: Project,
  api: API,
  importManager: ImportManager,
  value: ScalarValue | ArrayValue | ObjectValue
): string {
  switch (value.type) {
    case 'string':
    case 'number':
    case 'boolean':
      return value.type

    case 'integer':
      return 'number'

    case 'object':
      const additionalPropsType = generateTypeString(
        project,
        api,
        importManager,
        value.additionalProperties
      )
      return `Record<string, ${additionalPropsType}>`

    case 'array':
      const itemType = generateTypeString(project, api, importManager, value.items)
      return `Array<${itemType}>`

    default:
      return assertNever(value)
  }
}

// ============================================================================
// Main Generation Logic
// ============================================================================

/**
 * Main generation function that processes an API specification and generates TypeScript types
 * @param project The TypeScript project to generate into
 * @param api The OpenAPI specification
 */
export default function generateTypes(project: Project, api: API): void {
  const importManagers = new Map<string, ImportManager>()

  for (const {name, path: importPath, def} of extractDefinitions(api)) {
    if (name in ELIDED_TYPES) {
      continue
    }

    const sourceFile = ensureSourceFile(project, generateFilePath(importPath))
    let importManager = importManagers.get(sourceFile.getFilePath())

    if (!importManager) {
      importManager = new ImportManager(sourceFile)
      importManagers.set(sourceFile.getFilePath(), importManager)
    }

    const documentation = def.description ? [{description: def.description}] : []

    if (name in SCALAR_TYPES) {
      sourceFile.addTypeAlias({
        name,
        isExported: true,
        type: SCALAR_TYPES[name]!,
        docs: documentation,
      })
    } else {
      sourceFile.addInterface({
        name,
        isExported: true,
        properties: generateProperties(project, api, def, importManager),
        docs: documentation,
      })
    }
  }

  // Apply all imports
  for (const importManager of importManagers.values()) {
    importManager.applyImports()
  }
}

// ============================================================================
// API Fetching
// ============================================================================

/**
 * Fetches the Kubernetes API specification from GitHub
 * @param version The Kubernetes version to fetch
 * @returns Promise resolving to the API specification
 * @throws Error if the fetch fails or returns invalid data
 */
async function fetchKubernetesAPI(version: string): Promise<API> {
  const url = `https://raw.githubusercontent.com/kubernetes/kubernetes/${version}/api/openapi-spec/swagger.json`

  try {
    const response = await fetch(url)

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    }

    const apiData = (await response.json()) as any

    // Basic validation
    if (!apiData.info || !apiData.definitions) {
      throw new Error('Invalid API specification: missing required fields')
    }

    return apiData as API
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to fetch Kubernetes API for version ${version}: ${errorMessage}`)
  }
}

// ============================================================================
// CLI Logic
// ============================================================================

/**
 * Main CLI function
 */
async function main(): Promise<void> {
  const pkg = JSON.parse(readFileSync(path.join(__dirname, 'package.json'), 'utf8'))
  const apiVersion = normalizeVersion(pkg.version)

  console.log(`Generating types for Kubernetes API version: ${apiVersion}`)

  // Load API specification
  const api: API = await fetchKubernetesAPI(apiVersion)

  console.log(`Loaded API specification: ${api.info.title} ${api.info.version}`)

  // Create TypeScript project
  const project = new Project({
    compilerOptions: {
      target: ScriptTarget.ES2016,
      declaration: true,
    },
    useInMemoryFileSystem: true,
  })

  // Generate types
  generateTypes(project, api)

  // Emit files
  const emitResult = project.emitToMemory({emitOnlyDtsFiles: true})
  const generatedFiles = emitResult.getFiles()

  // Write files to disk
  const destinationPath = path.normalize(path.join(__dirname, 'dist'))

  console.log(`Writing ${generatedFiles.length} files to ${destinationPath}`)

  for (const {filePath, text} of generatedFiles) {
    const destFilePath = path.join(destinationPath, filePath.replace(/^\//, ''))
    mkdirSync(path.dirname(destFilePath), { recursive: true })
    writeFileSync(destFilePath, text, 'utf8')
    console.log(`Generated: ${apiVersion}${filePath}`)
  }

  console.log(`Successfully generated types for Kubernetes ${apiVersion}`)
}

// Execute main function
main().catch((error: Error) => {
  console.error('Error:', error.message)
  console.error(error.stack)
  process.exit(1)
})
