/**
 * apps/web/eslint.pixi-destroy.js — a Pixi Application is torn down only by
 * `destroyPixiApplication` (apps/web/src/renderer/pixiApplication.ts).
 *
 * `app.destroy(true, …)` — like `renderer.destroy(true)` or any
 * `releaseGlobalResources: true` — empties Pixi's page-wide pools, which
 * destroys the draw batches every other live Application in the page is
 * drawing with: the editor canvas then throws on every frame and stops
 * painting (pixiApplication.ts has the whole story). This rule keeps that
 * call in one file.
 *
 * Why a rule and not `no-restricted-syntax`: the one-door block already
 * configures `no-restricted-syntax` for apps/web/src, and flat config replaces
 * a rule's options across blocks instead of merging them — a second block
 * would silently drop the one-door selectors. And a selector sees names only:
 * `texture.destroy(true)` (destroy the source too) is legitimate and common,
 * so "`destroy` with `true`" cannot be the test.
 *
 * What it reports, outside pixiApplication.ts:
 *
 * 1. `destroy(…)` on a value known to be a pixi.js `Application` — bound by
 *    `new Application()` (declaration or assignment), typed `Application`
 *    (a variable, a parameter, a class field; unions such as
 *    `Application | null` count), or a `useRef<Application | null>` /
 *    `RefObject<Application>` read through `.current` — and on its
 *    `.renderer`. Resolved through scopes, so another `app` elsewhere is not
 *    confused with it; aliased imports and `import type` count.
 * 2. `destroy(true, …)` on a receiver *named* like an Application or a
 *    renderer (`app`, `liveApp`, `application`, `appRef.current`,
 *    `renderer`, `x.renderer`) — the untyped case 1 cannot see. Never
 *    `texture.destroy(true)` or `container.destroy({ children: true })`.
 * 3. A `releaseGlobalResources` option that is not literally `false`,
 *    whatever it is passed to.
 */

/** The one file that may destroy an Application. */
export const PIXI_APPLICATION_MODULE = 'apps/web/src/renderer/pixiApplication.ts'

export const PIXI_DESTROY_FILES = ['apps/web/**/*.{ts,tsx}']
export const PIXI_DESTROY_IGNORES = [PIXI_APPLICATION_MODULE]

const FIX = 'use destroyPixiApplication() from renderer/pixiApplication.ts'

/** `app`, `application`, `liveApp`, `pixiApplication` — camelCase-bounded. */
const APP_NAME = /^(?:app|application)$|[a-z0-9]App$|[a-z0-9]Application$/
const RENDERER_NAME = /^renderer$/

/** Strip wrappers that do not change what is called: `a!.b`, `a?.b`. */
function unwrap(node) {
  let current = node
  while (
    current &&
    (current.type === 'ChainExpression' ||
      current.type === 'TSNonNullExpression' ||
      current.type === 'TSAsExpression')
  ) {
    current = current.expression
  }
  return current
}

function findVariable(scope, name) {
  for (let s = scope; s; s = s.upper) {
    const variable = s.set.get(name)
    if (variable) return variable
  }
  return null
}

/** @type {import('eslint').Rule.RuleModule} */
const applicationDestroyRule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Tear a Pixi Application down only through destroyPixiApplication (renderer/pixiApplication.ts)',
    },
    schema: [],
    messages: {
      applicationDestroy:
        'A Pixi Application (or its renderer) is destroyed directly — {{fix}}: a direct destroy can ' +
        "release Pixi's page-wide pools under every other Application in the page.",
      destroyTrue:
        "`destroy(true, …)` on a Pixi Application or renderer releases Pixi's page-wide pools " +
        'under every other Application in the page — {{fix}}.',
      releaseGlobal:
        "`releaseGlobalResources` empties Pixi's page-wide pools under every other Application " +
        'in the page — {{fix}}.',
    },
  },
  create(context) {
    const sourceCode = context.sourceCode
    /** Local names of pixi's Application class (`Application`, an alias). */
    const appClassNames = new Set()
    /** Local names of `import * as PIXI from 'pixi.js'`. */
    const pixiNamespaces = new Set()
    /** Variables holding an Application, and refs whose `.current` holds one. */
    const appVars = new Set()
    const appRefVars = new Set()
    /** Class fields holding an Application (`this.app`). */
    const appMembers = new Set()
    /** destroy() calls, judged once the whole file is known (uses may precede assignments). */
    const destroyCalls = []

    const isPixiSource = (value) =>
      typeof value === 'string' && (value === 'pixi.js' || value.startsWith('@pixi/'))

    const isAppClass = (node) => {
      const n = unwrap(node)
      if (!n) return false
      if (n.type === 'Identifier') return appClassNames.has(n.name)
      if (n.type === 'TSQualifiedName' || n.type === 'MemberExpression') {
        const left = n.type === 'TSQualifiedName' ? n.left : n.object
        const right = n.type === 'TSQualifiedName' ? n.right : n.property
        return (
          left.type === 'Identifier' &&
          pixiNamespaces.has(left.name) &&
          right.name === 'Application'
        )
      }
      return false
    }

    /** Does a TS type mention pixi's Application (directly or in a union)? */
    const typeIsApp = (type) => {
      if (!type) return false
      switch (type.type) {
        case 'TSTypeAnnotation':
          return typeIsApp(type.typeAnnotation)
        case 'TSUnionType':
        case 'TSIntersectionType':
          return type.types.some(typeIsApp)
        case 'TSTypeReference':
          return isAppClass(type.typeName)
        default:
          return false
      }
    }

    const typeArgs = (node) => (node.typeArguments ?? node.typeParameters)?.params ?? []

    /** `RefObject<Application>`, `MutableRefObject<Application | null>`. */
    const typeIsAppRef = (type) => {
      if (!type) return false
      if (type.type === 'TSTypeAnnotation') return typeIsAppRef(type.typeAnnotation)
      if (type.type === 'TSUnionType') return type.types.some(typeIsAppRef)
      if (type.type !== 'TSTypeReference') return false
      const name =
        type.typeName.type === 'Identifier'
          ? type.typeName.name
          : type.typeName.type === 'TSQualifiedName'
            ? type.typeName.right.name
            : ''
      return /Ref(?:Object)?$/.test(name) && typeArgs(type).some(typeIsApp)
    }

    const isUseRefOfApp = (init) => {
      const call = unwrap(init)
      if (!call || call.type !== 'CallExpression') return false
      const callee = call.callee
      const name =
        callee.type === 'Identifier'
          ? callee.name
          : callee.type === 'MemberExpression' && !callee.computed
            ? callee.property.name
            : ''
      return name === 'useRef' && typeArgs(call).some(typeIsApp)
    }

    const isNewApp = (init) => {
      const n = unwrap(init)
      if (!n) return false
      if (n.type === 'AwaitExpression') return isNewApp(n.argument)
      return n.type === 'NewExpression' && isAppClass(n.callee)
    }

    const markIdentifier = (identifier, set) => {
      const variable = findVariable(sourceCode.getScope(identifier), identifier.name)
      if (variable) set.add(variable)
    }

    const resolves = (identifier, set) => {
      const variable = findVariable(sourceCode.getScope(identifier), identifier.name)
      return variable !== null && set.has(variable)
    }

    /** Is `node` (a call's receiver) an Application? */
    const isAppValue = (node) => {
      const n = unwrap(node)
      if (!n) return false
      if (n.type === 'Identifier') return resolves(n, appVars)
      if (n.type === 'MemberExpression' && !n.computed && n.property.type === 'Identifier') {
        const object = unwrap(n.object)
        if (object.type === 'ThisExpression') return appMembers.has(n.property.name)
        if (n.property.name === 'current' && object.type === 'Identifier') {
          return resolves(object, appRefVars)
        }
      }
      return false
    }

    /** The name a receiver goes by: `app`, `this.app`, `appRef.current` → `app`. */
    const receiverName = (node) => {
      const n = unwrap(node)
      if (!n) return ''
      if (n.type === 'Identifier') return n.name
      if (n.type === 'MemberExpression' && !n.computed && n.property.type === 'Identifier') {
        if (n.property.name === 'current') {
          const object = unwrap(n.object)
          if (object.type === 'Identifier') return object.name.replace(/Ref$/, '')
          if (object.type === 'MemberExpression' && !object.computed) {
            return object.property.name.replace(/Ref$/, '')
          }
        }
        return n.property.name
      }
      return ''
    }

    const markParams = (fn) => {
      for (const param of fn.params) {
        const id = param.type === 'AssignmentPattern' ? param.left : param
        if (id.type !== 'Identifier' || !id.typeAnnotation) continue
        const variable = sourceCode.getDeclaredVariables(fn).find((v) => v.name === id.name)
        if (!variable) continue
        if (typeIsApp(id.typeAnnotation)) appVars.add(variable)
        else if (typeIsAppRef(id.typeAnnotation)) appRefVars.add(variable)
      }
    }

    return {
      ImportDeclaration(node) {
        if (!isPixiSource(node.source.value)) return
        for (const spec of node.specifiers) {
          if (spec.type === 'ImportNamespaceSpecifier') pixiNamespaces.add(spec.local.name)
          else if (
            spec.type === 'ImportSpecifier' &&
            (spec.imported.name ?? spec.imported.value) === 'Application'
          ) {
            appClassNames.add(spec.local.name)
          }
        }
      },
      VariableDeclarator(node) {
        if (node.id.type !== 'Identifier') return
        const variable = sourceCode.getDeclaredVariables(node)[0]
        if (!variable) return
        if (typeIsApp(node.id.typeAnnotation) || isNewApp(node.init)) appVars.add(variable)
        else if (typeIsAppRef(node.id.typeAnnotation) || isUseRefOfApp(node.init)) {
          appRefVars.add(variable)
        }
      },
      AssignmentExpression(node) {
        if (!isNewApp(node.right)) return
        const left = unwrap(node.left)
        if (left.type === 'Identifier') markIdentifier(left, appVars)
        else if (
          left.type === 'MemberExpression' &&
          !left.computed &&
          unwrap(left.object).type === 'ThisExpression'
        ) {
          appMembers.add(left.property.name)
        }
      },
      PropertyDefinition(node) {
        if (node.key.type !== 'Identifier') return
        if (typeIsApp(node.typeAnnotation) || isNewApp(node.value)) appMembers.add(node.key.name)
      },
      FunctionDeclaration: markParams,
      FunctionExpression: markParams,
      ArrowFunctionExpression: markParams,
      Property(node) {
        const key =
          node.key.type === 'Identifier'
            ? node.key.name
            : node.key.type === 'Literal'
              ? node.key.value
              : ''
        if (key !== 'releaseGlobalResources') return
        if (node.value.type === 'Literal' && node.value.value === false) return
        context.report({ node, messageId: 'releaseGlobal', data: { fix: FIX } })
      },
      CallExpression(node) {
        const callee = unwrap(node.callee)
        if (
          callee.type === 'MemberExpression' &&
          !callee.computed &&
          callee.property.type === 'Identifier' &&
          callee.property.name === 'destroy'
        ) {
          destroyCalls.push({ node, receiver: callee.object })
        }
      },
      'Program:exit'() {
        for (const { node, receiver } of destroyCalls) {
          const r = unwrap(receiver)
          // `app.renderer.destroy(…)` of a known Application.
          const rendererOfApp =
            r.type === 'MemberExpression' &&
            !r.computed &&
            r.property.type === 'Identifier' &&
            r.property.name === 'renderer' &&
            isAppValue(r.object)
          if (isAppValue(r) || rendererOfApp) {
            context.report({ node, messageId: 'applicationDestroy', data: { fix: FIX } })
            continue
          }
          const first = node.arguments[0]
          if (!first || first.type !== 'Literal' || first.value !== true) continue
          const name = receiverName(r)
          if (APP_NAME.test(name) || RENDERER_NAME.test(name)) {
            context.report({ node, messageId: 'destroyTrue', data: { fix: FIX } })
          }
        }
      },
    }
  },
}

/** Flat-config plugin: `plugins: { 'narrative-pixi': PIXI_DESTROY_PLUGIN }`. */
export const PIXI_DESTROY_PLUGIN = {
  meta: { name: 'narrative-pixi' },
  rules: { 'application-destroy': applicationDestroyRule },
}

export const PIXI_DESTROY_RULES = { 'narrative-pixi/application-destroy': 'error' }
