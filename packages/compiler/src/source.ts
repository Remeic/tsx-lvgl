import { readFileSync } from "node:fs";
import * as ts from "typescript";
import {
  exprStates,
  type BinaryOp,
  type CompareOp,
  type NativeAction,
  type NativeBinding,
  type NativeCondition,
  type NativeExpr,
  type NativeNode,
  type NativeProgram,
  type NativeState,
  type NativeText,
} from "./native-program.js";

const REACT_MODULE = "@tsx-lvgl/react";
const MIN_INT32 = -2147483648n;
const MAX_INT32 = 2147483647n;

export interface SourceCompileConfig {
  readonly entryFile: string;
  readonly projectName?: string;
}

export class SourceCompileError extends Error {
  readonly code = "TSXL001";
  readonly fileName: string;
  readonly line: number;
  readonly column: number;

  public constructor(fileName: string, line: number, column: number, detail: string) {
    super(`${fileName}:${line}:${column}: ${detail}`);
    this.name = "SourceCompileError";
    this.fileName = fileName;
    this.line = line;
    this.column = column;
  }
}

interface ComponentDeclaration {
  readonly name: string;
  readonly node: ts.FunctionDeclaration | ts.ArrowFunction;
}

interface StateBinding {
  readonly sourceName: string;
  readonly setterName: string;
  readonly stateId: string;
}

/**
 * A build-time value bound to an identifier: a state slot, or a compile-time
 * constant fed in through a prop or a list-item parameter. Props and list items
 * carry no device runtime; they are resolved entirely here.
 */
type CompileValue =
  | { readonly kind: "int"; readonly value: bigint }
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "state"; readonly binding: StateBinding };

interface PropValue {
  readonly value: CompileValue;
  readonly node: ts.Node;
}

interface ComponentContext {
  readonly component: ComponentDeclaration;
  readonly instancePath: string;
  readonly statesBySourceName: Map<string, StateBinding>;
  readonly setters: Map<string, StateBinding>;
  readonly handlers: Map<string, string>;
  /** Prop and list-item bindings visible to expressions in this instance. */
  readonly env: Map<string, CompileValue>;
  readonly actionIndexes: { value: number };
  hookIndex: number;
}

interface SourceProgram {
  readonly program: NativeProgram;
  readonly entryFile: string;
}

const UNSUPPORTED_REACT_IMPORTS: Readonly<Record<string, string>> = {
  useEffect: "effects",
  useLayoutEffect: "layout effects",
  useRef: "refs",
  useContext: "context",
  createContext: "context",
  useMemo: "memoization hooks",
  useCallback: "memoization hooks",
  useReducer: "reducers",
  Suspense: "suspense",
  use: "the use() hook",
};

export function compileSourceToProgram(config: SourceCompileConfig): SourceProgram {
  const sourceText = readFileSync(config.entryFile, "utf8");
  const sourceFile = ts.createSourceFile(
    config.entryFile,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const parseDiagnostics = (sourceFile as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
  const parseDiagnostic = parseDiagnostics[0];
  if (parseDiagnostic !== undefined) {
    const start = parseDiagnostic.start ?? 0;
    const location = sourceFile.getLineAndCharacterOfPosition(start);
    throw new SourceCompileError(
      config.entryFile,
      location.line + 1,
      location.character + 1,
      ts.flattenDiagnosticMessageText(parseDiagnostic.messageText, " "),
    );
  }
  const compiler = new SourceCompiler(sourceFile);
  return {
    program: compiler.compile(),
    entryFile: config.entryFile,
  };
}

class SourceCompiler {
  private readonly components = new Map<string, ComponentDeclaration>();
  private readonly intrinsicNames = new Map<string, string>();
  private readonly hookNames = new Set<string>();
  private readonly states: NativeState[] = [];
  private readonly bindings: NativeBinding[] = [];
  private readonly conditions: NativeCondition[] = [];
  private readonly bindingCounters = new Map<string, number>();
  private readonly actions: Record<string, NativeAction> = {};
  private readonly sourceFile: ts.SourceFile;
  private defaultRootName: string | undefined;
  private firstButtonActionId: string | undefined;

  public constructor(sourceFile: ts.SourceFile) {
    this.sourceFile = sourceFile;
    this.collectDeclarations();
  }

  public compile(): NativeProgram {
    const rootName = this.defaultRootName;
    if (rootName === undefined) {
      this.fail(this.sourceFile, "entry file must have a default-exported root component");
    }
    const rootComponent = this.components.get(rootName);
    if (rootComponent === undefined) {
      this.fail(this.sourceFile, `default export ${rootName} is not a supported function component`);
    }

    const root = this.renderComponent(rootComponent, "root", []);
    if (root.kind !== "screen") {
      this.fail(rootComponent.node, "default root must return <Screen>...</Screen>");
    }

    const program: NativeProgram = {
      format: "tsx-lvgl-native-program-v0",
      root,
      states: [...this.states],
      bindings: [...this.bindings],
      conditions: [...this.conditions],
      actions: { ...this.actions },
    };
    if (this.firstButtonActionId !== undefined) {
      return { ...program, testButtonActionId: this.firstButtonActionId };
    }
    return program;
  }

  private collectDeclarations(): void {
    for (const statement of this.sourceFile.statements) {
      if (ts.isImportDeclaration(statement)) {
        this.collectImport(statement);
        continue;
      }
      if (ts.isFunctionDeclaration(statement)) {
        if (statement.name === undefined) {
          if (this.hasModifier(statement, ts.SyntaxKind.DefaultKeyword)) {
            this.fail(statement, "default function component must have a name");
          }
          continue;
        }
        this.components.set(statement.name.text, { name: statement.name.text, node: statement });
        if (this.hasModifier(statement, ts.SyntaxKind.DefaultKeyword)) this.defaultRootName = statement.name.text;
        continue;
      }
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (declaration.name.kind !== ts.SyntaxKind.Identifier
              || declaration.initializer === undefined
              || !ts.isArrowFunction(declaration.initializer)) {
            this.fail(declaration, "unsupported top-level variable; only arrow function components are supported");
          }
          const name = (declaration.name as ts.Identifier).text;
          this.components.set(name, { name, node: declaration.initializer });
        }
        continue;
      }
      if (ts.isExportAssignment(statement)) {
        if (statement.isExportEquals) this.fail(statement, "CommonJS export assignment is unsupported");
        if (ts.isIdentifier(statement.expression)) {
          this.defaultRootName = statement.expression.text;
        } else if (ts.isArrowFunction(statement.expression)) {
          const name = "__default_root";
          this.components.set(name, { name, node: statement.expression });
          this.defaultRootName = name;
        } else {
          this.fail(statement.expression, "default export must reference a function component");
        }
        continue;
      }
      if (this.isIgnorableDeclaration(statement)) continue;
      if (ts.isExportDeclaration(statement) || ts.isModuleDeclaration(statement)) {
        this.fail(statement, "module re-exports and namespaces are unsupported in the MVP");
      }
      this.fail(statement, "unsupported top-level syntax; keep the entry file to imports, components, and a default export");
    }
  }

  private collectImport(statement: ts.ImportDeclaration): void {
    if (statement.importClause?.isTypeOnly === true) return;
    const moduleName = ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : "";
    if (moduleName !== REACT_MODULE) {
      this.fail(statement.moduleSpecifier, `only ${REACT_MODULE} imports are supported`);
    }
    const clause = statement.importClause;
    if (clause === undefined) return;
    if (clause.name !== undefined) this.fail(clause.name, "default imports are unsupported; import named compatibility APIs");
    if (clause.namedBindings !== undefined && ts.isNamespaceImport(clause.namedBindings)) {
      this.fail(clause.namedBindings, "namespace imports are unsupported; import named compatibility APIs");
    }
    const namedBindings = clause.namedBindings;
    for (const specifier of namedBindings !== undefined && ts.isNamedImports(namedBindings) ? namedBindings.elements : []) {
      if (specifier.isTypeOnly) continue;
      const imported = specifier.propertyName?.text ?? specifier.name.text;
      const local = specifier.name.text;
      switch (imported) {
        case "Screen":
        case "View":
        case "Text":
        case "Button":
        case "Fragment":
          this.intrinsicNames.set(local, imported);
          break;
        case "useState":
          this.hookNames.add(local);
          break;
        default: {
          const feature = UNSUPPORTED_REACT_IMPORTS[imported];
          if (feature !== undefined) {
            this.fail(
              specifier,
              `${imported} is unsupported: ${feature} need a JavaScript runtime, which the fixed-tree native target does not include`,
            );
          }
          this.fail(specifier, `unsupported @tsx-lvgl/react import ${imported}`);
        }
      }
    }
  }

  private renderComponent(
    component: ComponentDeclaration,
    instancePath: string,
    stack: readonly string[],
    props?: ReadonlyMap<string, PropValue>,
  ): NativeNode {
    if (this.hasModifier(component.node, ts.SyntaxKind.AsyncKeyword)) {
      this.fail(component.node, "async components are unsupported in the fixed-tree MVP");
    }
    if (stack.includes(component.name)) {
      this.fail(component.node, `recursive component composition is unsupported (${component.name})`);
    }

    const env = this.bindProps(component, props);

    const context: ComponentContext = {
      component,
      instancePath,
      statesBySourceName: new Map(),
      setters: new Map(),
      handlers: new Map(),
      env,
      actionIndexes: { value: 0 },
      hookIndex: 0,
    };
    const nextStack = [...stack, component.name];
    if (ts.isArrowFunction(component.node) && !ts.isBlock(component.node.body)) {
      return this.renderJsx(component.node.body, context, `${instancePath}_return`, nextStack);
    }
    const body = component.node.body;
    if (body === undefined || !ts.isBlock(body)) this.fail(component.node, "component must have a function body");
    let returned: NativeNode | undefined;
    for (const statement of body.statements) {
      if (ts.isVariableStatement(statement)) {
        this.readComponentVariable(statement, context);
        continue;
      }
      if (ts.isReturnStatement(statement)) {
        if (returned !== undefined) this.fail(statement, "component must have exactly one return statement");
        if (statement.expression === undefined) this.fail(statement, "component return must be a TSX element");
        returned = this.renderJsx(statement.expression, context, `${instancePath}_return`, nextStack);
        continue;
      }
      this.fail(statement, "unsupported component syntax; only top-level useState declarations, local arrow handlers, and return are supported");
    }
    if (returned === undefined) this.fail(component.node, "component must return a TSX element");
    return returned;
  }

  /** Resolve call-site props against a component's single destructured parameter. */
  private bindProps(component: ComponentDeclaration, props?: ReadonlyMap<string, PropValue>): Map<string, CompileValue> {
    const env = new Map<string, CompileValue>();
    const parameters = component.node.parameters;
    if (parameters.length === 0) {
      const first = props !== undefined ? [...props.values()][0] : undefined;
      if (first !== undefined) this.fail(first.node, `component ${component.name} does not accept props`);
      return env;
    }
    if (parameters.length > 1) this.fail(parameters[1]!, "components accept at most one destructured props parameter");
    const parameter = parameters[0]!;
    if (!ts.isObjectBindingPattern(parameter.name)) {
      this.fail(parameter, "component props must be a single destructured object parameter, for example ({ value })");
    }
    const required = new Set<string>();
    for (const element of parameter.name.elements) {
      if (element.dotDotDotToken !== undefined) this.fail(element, "rest props are unsupported");
      if (element.propertyName !== undefined || !ts.isIdentifier(element.name)) {
        this.fail(element, "props must be plain destructured names without renaming or nesting");
      }
      const name = element.name.text;
      required.add(name);
      const provided = props?.get(name);
      if (provided === undefined) {
        if (element.initializer !== undefined) {
          env.set(name, this.readDefaultProp(element.initializer));
          continue;
        }
        this.fail(element, `missing required prop ${name}`);
      }
      env.set(name, provided.value);
    }
    if (props !== undefined) {
      for (const [name, entry] of props) {
        if (!required.has(name)) this.fail(entry.node, `unknown prop ${name} for component ${component.name}`);
      }
    }
    return env;
  }

  private readDefaultProp(initializer: ts.Expression): CompileValue {
    const literal = this.tryParseIntegerLiteral(initializer);
    if (literal !== undefined) return { kind: "int", value: literal };
    if (ts.isStringLiteral(initializer)) return { kind: "string", value: initializer.text };
    this.fail(initializer, "prop defaults must be an integer or string literal");
  }

  private readComponentVariable(statement: ts.VariableStatement, context: ComponentContext): void {
    if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) {
      this.fail(statement, "component locals must be const declarations");
    }
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isArrayBindingPattern(declaration.name)) {
        this.readStateDeclaration(declaration, context);
        continue;
      }
      if (!ts.isIdentifier(declaration.name) || declaration.initializer === undefined || !ts.isArrowFunction(declaration.initializer)) {
        this.fail(declaration, "unsupported component local; only useState destructuring and arrow event handlers are supported");
      }
      const actionId = this.addHandler(declaration.initializer, context);
      context.handlers.set(declaration.name.text, actionId);
    }
  }

  private readStateDeclaration(declaration: ts.VariableDeclaration, context: ComponentContext): void {
    const binding = declaration.name as ts.ArrayBindingPattern;
    if (binding.elements.length !== 2 || binding.elements.some((element) => !ts.isBindingElement(element) || !ts.isIdentifier(element.name))) {
      this.fail(binding, "useState must destructure exactly [state, setState]");
    }
    const stateName = (binding.elements[0] as ts.BindingElement).name as ts.Identifier;
    const setterName = (binding.elements[1] as ts.BindingElement).name as ts.Identifier;
    const initializer = declaration.initializer;
    if (initializer === undefined || !ts.isCallExpression(initializer) || !ts.isIdentifier(initializer.expression) || !this.hookNames.has(initializer.expression.text)) {
      this.fail(declaration, "state declarations must be const [state, setState] = useState(integerLiteral)");
    }
    if (initializer.arguments.length !== 1) this.fail(initializer, "useState requires one signed 32-bit integer literal");
    const initial = this.parseInitialInteger(initializer.arguments[0]!);
    const stateId = `${sanitize(context.instancePath)}_s${context.hookIndex}`;
    context.hookIndex += 1;
    this.states.push({ id: stateId, initial });
    const stateBinding: StateBinding = { sourceName: stateName.text, setterName: setterName.text, stateId };
    context.statesBySourceName.set(stateName.text, stateBinding);
    context.setters.set(setterName.text, stateBinding);
  }

  private addHandler(handler: ts.ArrowFunction, context: ComponentContext): string {
    const actionId = `${sanitize(context.instancePath)}_a${context.actionIndexes.value}`;
    context.actionIndexes.value += 1;
    this.actions[actionId] = this.parseHandler(handler, context);
    return actionId;
  }

  private parseHandler(handler: ts.ArrowFunction, context: ComponentContext): NativeAction {
    if (this.hasModifier(handler, ts.SyntaxKind.AsyncKeyword)) {
      this.fail(handler, "async event handlers are unsupported in the fixed-tree MVP");
    }
    if (handler.parameters.length !== 0) this.fail(handler.parameters[0]!, "event handlers cannot receive parameters");
    const expression = ts.isBlock(handler.body)
      ? this.readSingleHandlerStatement(handler.body, handler)
      : handler.body;
    if (!ts.isCallExpression(expression) || !ts.isIdentifier(expression.expression)) {
      this.fail(handler, "event handlers must call a local state setter");
    }
    const binding = context.setters.get(expression.expression.text);
    if (binding === undefined) this.fail(expression.expression, `unknown state setter ${expression.expression.text}`);
    if (expression.arguments.length !== 1) this.fail(expression, "state setters require exactly one update argument");
    const expr = this.parseStateUpdate(binding, expression.arguments[0]!, context);
    return { kind: "assign", stateId: binding.stateId, expr };
  }

  private readSingleHandlerStatement(block: ts.Block, diagnosticNode: ts.Node): ts.Expression {
    const statement = block.statements[0];
    if (block.statements.length !== 1 || statement === undefined || !ts.isExpressionStatement(statement)) {
      this.fail(diagnosticNode, "event handler blocks must contain exactly one state-setter call");
    }
    return statement.expression;
  }

  private parseStateUpdate(binding: StateBinding, update: ts.Expression, context: ComponentContext): NativeExpr {
    const literal = this.tryParseIntegerLiteral(update);
    if (literal !== undefined) {
      return { kind: "literal", value: this.requireInt32(literal, update, "state setter integer literal must be a signed 32-bit integer literal") };
    }
    if (ts.isArrowFunction(update)) {
      if (this.hasModifier(update, ts.SyntaxKind.AsyncKeyword)) {
        this.fail(update, "async state updates are unsupported in the fixed-tree MVP");
      }
      if (update.parameters.length !== 1 || !ts.isIdentifier(update.parameters[0]!.name)) {
        this.fail(update, "functional state updates require one previous-value parameter");
      }
      const previousName = (update.parameters[0]!.name as ts.Identifier).text;
      const body = ts.isBlock(update.body) ? this.readSingleHandlerStatement(update.body, update) : update.body;
      const env = new Map(context.env);
      env.set(previousName, { kind: "state", binding });
      return this.parseExpr(body, { ...context, env });
    }
    // Bare setter argument: an integer expression over state, props, or literals.
    return this.parseExpr(update, context);
  }

  private renderJsx(
    expression: ts.Expression,
    context: ComponentContext,
    path: string,
    stack: readonly string[],
  ): NativeNode {
    if (ts.isParenthesizedExpression(expression)) {
      return this.renderJsx(expression.expression, context, path, stack);
    }
    if (ts.isJsxElement(expression)) {
      return this.renderJsxElement(expression.openingElement, expression.children, context, path, stack);
    }
    if (ts.isJsxSelfClosingElement(expression)) {
      return this.renderJsxElement(expression, [], context, path, stack);
    }
    if (ts.isJsxFragment(expression)) {
      return { kind: "fragment", children: this.renderChildren(expression.children, context, path, stack) };
    }
    this.fail(expression, "component return and composed children must be JSX elements or fragments");
  }

  private renderJsxElement(
    opening: ts.JsxOpeningLikeElement,
    children: readonly ts.JsxChild[],
    context: ComponentContext,
    path: string,
    stack: readonly string[],
  ): NativeNode {
    const tag = this.jsxTagName(opening.tagName);
    const intrinsic = this.intrinsicNames.get(tag);
    if (intrinsic === undefined) {
      const component = this.components.get(tag);
      if (component === undefined) this.fail(opening.tagName, `unknown component or intrinsic element ${tag}`);
      const props = this.collectProps(opening, context);
      const meaningfulChildren = children.filter((child) => !this.isWhitespaceJsxText(child));
      if (meaningfulChildren.length > 0) {
        this.fail(meaningfulChildren[0]!, "component children are unsupported in this MVP; compose zero-argument components");
      }
      return this.renderComponent(component, `${path}_c${this.childIndex(path)}`, stack, props);
    }
    switch (intrinsic) {
      case "Screen":
        this.requireNoAttributes(opening, "Screen");
        return { kind: "screen", children: this.renderChildren(children, context, path, stack) };
      case "Fragment":
        this.requireNoAttributes(opening, "Fragment");
        return { kind: "fragment", children: this.renderChildren(children, context, path, stack) };
      case "View":
        return this.renderView(opening, children, context, path, stack);
      case "Text":
        return this.renderText(opening, children, context, path);
      case "Button":
        return this.renderButton(opening, children, context, path);
    }
    return this.fail(opening, `unsupported intrinsic element ${intrinsic}`);
  }

  private collectProps(opening: ts.JsxOpeningLikeElement, context: ComponentContext): Map<string, PropValue> {
    const props = new Map<string, PropValue>();
    for (const property of opening.attributes.properties) {
      if (ts.isJsxSpreadAttribute(property)) this.fail(property, "spread props are unsupported");
      if (!ts.isJsxAttribute(property) || !ts.isIdentifier(property.name)) this.fail(property, "unsupported prop syntax");
      const name = property.name.text;
      props.set(name, { value: this.readPropValue(property, context), node: property });
    }
    return props;
  }

  private readPropValue(attribute: ts.JsxAttribute, context: ComponentContext): CompileValue {
    const initializer = attribute.initializer;
    if (initializer === undefined) this.fail(attribute, "boolean props are unsupported; pass an integer, string, or state value");
    if (ts.isStringLiteral(initializer)) return { kind: "string", value: initializer.text };
    if (!ts.isJsxExpression(initializer) || initializer.expression === undefined) {
      this.fail(attribute, "props must be a string, integer, or state identifier");
    }
    const expression = initializer.expression;
    const literal = this.tryParseIntegerLiteral(expression);
    if (literal !== undefined) return { kind: "int", value: literal };
    if (ts.isStringLiteral(expression)) return { kind: "string", value: expression.text };
    if (ts.isIdentifier(expression)) {
      const resolved = this.resolveName(expression.text, context);
      if (resolved !== undefined) return resolved;
      this.fail(expression, `unknown value ${expression.text} passed as prop`);
    }
    this.fail(attribute, "props must be a string, integer, or state identifier; expressions are unsupported");
  }

  private renderView(
    opening: ts.JsxOpeningLikeElement,
    children: readonly ts.JsxChild[],
    context: ComponentContext,
    path: string,
    stack: readonly string[],
  ): NativeNode {
    const direction = this.readStringAttribute(opening, "direction", "column", ["row", "column"] as const);
    const align = this.readStringAttribute(opening, "align", "start", ["start", "center", "end"] as const);
    const gap = this.readNonNegativeIntegerAttribute(opening, "gap", 0);
    this.requireOnlyAttributes(opening, ["direction", "align", "gap"]);
    return {
      kind: "view",
      direction,
      align,
      gap,
      children: this.renderChildren(children, context, path, stack),
    };
  }

  private renderText(
    opening: ts.JsxOpeningLikeElement,
    children: readonly ts.JsxChild[],
    context: ComponentContext,
    path: string,
  ): NativeNode {
    const textAttribute = this.findAttribute(opening, "text");
    const meaningfulChildren = children.filter((child) => !this.isWhitespaceJsxText(child));
    if (textAttribute !== undefined && meaningfulChildren.length > 0) {
      this.fail(textAttribute, "Text accepts either text= or one direct child, not both");
    }
    let value: NativeText;
    if (textAttribute !== undefined) {
      value = this.parseTextValue(textAttribute.initializer, context, textAttribute);
    } else if (meaningfulChildren.length === 1) {
      value = this.parseTextChild(meaningfulChildren[0]!, context);
    } else {
      this.fail(opening, "Text requires a direct string, integer, or state binding");
    }
    this.requireOnlyAttributes(opening, ["text"]);
    return { kind: "text", value };
  }

  private renderButton(
    opening: ts.JsxOpeningLikeElement,
    children: readonly ts.JsxChild[],
    context: ComponentContext,
    path: string,
  ): NativeNode {
    const labelAttribute = this.findAttribute(opening, "label");
    const onClickAttribute = this.findAttribute(opening, "onClick");
    const meaningfulChildren = children.filter((child) => !this.isWhitespaceJsxText(child));
    if (labelAttribute !== undefined && meaningfulChildren.length > 0) {
      this.fail(labelAttribute, "Button accepts either label= or one direct text child, not both");
    }
    let label: string;
    if (labelAttribute !== undefined) {
      label = this.parseStringValue(labelAttribute.initializer, labelAttribute);
    } else if (meaningfulChildren.length === 1 && ts.isJsxText(meaningfulChildren[0]!)) {
      label = meaningfulChildren[0]!.getText(this.sourceFile).trim();
    } else if (
      meaningfulChildren.length === 1
      && ts.isJsxExpression(meaningfulChildren[0]!)
      && meaningfulChildren[0]!.expression !== undefined
      && ts.isStringLiteral(meaningfulChildren[0]!.expression)
    ) {
      label = meaningfulChildren[0]!.expression.text;
    } else {
      this.fail(opening, "Button requires a label= string or one direct text child");
    }
    if (onClickAttribute === undefined) this.fail(opening, "Button requires onClick={handler}");
    const actionId = this.parseClickHandler(onClickAttribute, context);
    this.requireOnlyAttributes(opening, ["label", "onClick"]);
    if (this.firstButtonActionId === undefined) this.firstButtonActionId = actionId;
    return { kind: "button", label, actionId };
  }

  private parseClickHandler(attribute: ts.JsxAttribute, context: ComponentContext): string {
    const initializer = attribute.initializer;
    if (initializer === undefined || !ts.isJsxExpression(initializer) || initializer.expression === undefined) {
      this.fail(attribute, "onClick must be an inline arrow or same-component local arrow function");
    }
    const expression = initializer.expression;
    if (ts.isIdentifier(expression)) {
      const actionId = context.handlers.get(expression.text);
      if (actionId === undefined) this.fail(expression, `unknown local event handler ${expression.text}`);
      return actionId;
    }
    if (ts.isArrowFunction(expression)) {
      return this.addHandler(expression, context);
    }
    this.fail(expression, "onClick must be an inline arrow or same-component local arrow function");
  }

  private parseTextValue(
    initializer: ts.JsxAttributeValue | undefined,
    context: ComponentContext,
    node: ts.Node,
  ): NativeText {
    if (initializer === undefined) this.fail(node, "text requires a string, integer, or state expression");
    if (ts.isStringLiteral(initializer)) return { kind: "literal", value: initializer.text };
    if (!ts.isJsxExpression(initializer) || initializer.expression === undefined) this.fail(node, "text does not accept boolean or spread syntax");
    return this.parseTextExpression(initializer.expression, context);
  }

  private parseTextChild(child: ts.JsxChild, context: ComponentContext): NativeText {
    if (ts.isJsxText(child)) return { kind: "literal", value: child.getText(this.sourceFile).trim() };
    if (ts.isJsxExpression(child) && child.expression !== undefined) return this.parseTextExpression(child.expression, context);
    this.fail(child, "Text child must be a direct integer, string, or state binding");
  }

  private parseTextExpression(expression: ts.Expression, context: ComponentContext): NativeText {
    if (expression.kind === ts.SyntaxKind.TrueKeyword || expression.kind === ts.SyntaxKind.FalseKeyword) {
      this.fail(expression, "Text does not accept boolean values");
    }
    // Any non-binary compile-time constant (integer literal preserved exactly,
    // even outside int32; string literal; or a prop/list-item identifier).
    if (!ts.isBinaryExpression(expression)) {
      const constant = this.constText(expression, context);
      if (constant !== undefined) return { kind: "literal", value: constant };
    }
    // Compile-time string concatenation folds to one literal.
    const folded = this.tryFoldConcat(expression, context);
    if (folded !== undefined) return { kind: "literal", value: folded };
    // General integer expression. Constant folds to literal text; otherwise a
    // live int32 binding recomputed whenever a referenced state changes.
    const expr = this.parseExpr(expression, context);
    const constant = evalConstExpr(expr);
    if (constant !== undefined) return { kind: "literal", value: String(constant) };
    return { kind: "binding", bindingId: this.addBinding(expr) };
  }

  private addBinding(expr: NativeExpr): string {
    // A binding is named after the first state it reads; a per-owner counter
    // disambiguates several bindings of the same state.
    const owner = [...exprStates(expr)][0] ?? "root";
    const index = this.bindingCounters.get(owner) ?? 0;
    this.bindingCounters.set(owner, index + 1);
    const id = `${owner}_b${index}`;
    this.bindings.push({ id, expr });
    return id;
  }

  private renderChildren(
    children: readonly ts.JsxChild[],
    context: ComponentContext,
    path: string,
    stack: readonly string[],
  ): readonly NativeNode[] {
    const result: NativeNode[] = [];
    for (const [index, child] of children.entries()) {
      if (this.isWhitespaceJsxText(child)) continue;
      if (ts.isJsxText(child)) this.fail(child, "text children are only supported inside Text and Button");
      if (ts.isJsxExpression(child)) {
        if (child.expression === undefined) this.fail(child, "empty expressions are not valid children");
        result.push(...this.renderExpressionChild(child.expression, context, `${path}_${index}`, stack));
        continue;
      }
      result.push(this.renderJsx(child, context, `${path}_${index}`, stack));
    }
    return result;
  }

  private renderExpressionChild(
    expression: ts.Expression,
    context: ComponentContext,
    path: string,
    stack: readonly string[],
  ): NativeNode[] {
    if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      return [this.renderConditional(expression.left, expression.right, undefined, context, path, stack)];
    }
    if (ts.isConditionalExpression(expression)) {
      return [this.renderConditional(expression.condition, expression.whenTrue, expression.whenFalse, context, path, stack)];
    }
    if (ts.isCallExpression(expression)) {
      return this.renderListChildren(expression, context, path, stack);
    }
    this.fail(
      expression,
      "expression children must be a state conditional ({cond && <X/>} or a ternary) or an array-literal .map(...)",
    );
  }

  private renderConditional(
    condition: ts.Expression,
    whenTrue: ts.Expression,
    whenFalse: ts.Expression | undefined,
    context: ComponentContext,
    path: string,
    stack: readonly string[],
  ): NativeNode {
    const predicate = this.parseExpr(condition, context);

    // Fold a constant predicate BEFORE rendering branches: rendering registers
    // bindings/actions/conditions as side effects, so a discarded branch would
    // otherwise leak dangling globals (a NULL label pointer, a dead handler).
    const constant = evalConstExpr(predicate);
    if (constant !== undefined) {
      if (constant !== 0) return this.renderBranch(whenTrue, context, `${path}_t`, stack);
      return whenFalse === undefined
        ? { kind: "fragment", children: [] }
        : this.renderBranch(whenFalse, context, `${path}_f`, stack);
    }

    const consequent = this.renderBranch(whenTrue, context, `${path}_t`, stack);
    const alternate = whenFalse === undefined ? undefined : this.renderBranch(whenFalse, context, `${path}_f`, stack);
    const condId = sanitize(path);
    this.conditions.push({ id: condId, predicate, hasAlternate: alternate !== undefined });
    return { kind: "conditional", condId, consequent, alternate };
  }

  private renderBranch(
    expression: ts.Expression,
    context: ComponentContext,
    path: string,
    stack: readonly string[],
  ): NativeNode {
    if (expression.kind === ts.SyntaxKind.NullKeyword || expression.kind === ts.SyntaxKind.FalseKeyword) {
      return { kind: "fragment", children: [] };
    }
    return this.renderJsx(expression, context, path, stack);
  }

  private renderListChildren(
    call: ts.CallExpression,
    context: ComponentContext,
    path: string,
    stack: readonly string[],
  ): NativeNode[] {
    if (!ts.isPropertyAccessExpression(call.expression) || call.expression.name.text !== "map") {
      this.fail(call, "list children must be an array-literal .map(callback)");
    }
    const source = call.expression.expression;
    if (!ts.isArrayLiteralExpression(source)) {
      this.fail(source, "list source must be an inline array literal; runtime-length lists break the fixed tree");
    }
    if (call.arguments.length !== 1 || !ts.isArrowFunction(call.arguments[0]!)) {
      this.fail(call, "list .map requires one inline arrow callback");
    }
    const callback = call.arguments[0] as ts.ArrowFunction;
    if (callback.parameters.length < 1 || callback.parameters.length > 2) {
      this.fail(callback, "list callback takes (item) or (item, index)");
    }
    const itemParameter = callback.parameters[0]!;
    const indexParameter = callback.parameters[1];
    if (!ts.isIdentifier(itemParameter.name) || (indexParameter !== undefined && !ts.isIdentifier(indexParameter.name))) {
      this.fail(callback, "list callback parameters must be plain identifiers");
    }
    const itemName = (itemParameter.name as ts.Identifier).text;
    const indexName = indexParameter === undefined ? undefined : (indexParameter.name as ts.Identifier).text;
    const body = ts.isBlock(callback.body) ? this.readSingleReturn(callback.body, callback) : callback.body;

    const nodes: NativeNode[] = [];
    source.elements.forEach((element, elementIndex) => {
      const itemValue = this.readListElement(element);
      const env = new Map(context.env);
      env.set(itemName, itemValue);
      if (indexName !== undefined) env.set(indexName, { kind: "int", value: BigInt(elementIndex) });
      const childContext: ComponentContext = { ...context, env };
      nodes.push(this.renderJsx(body, childContext, `${path}_i${elementIndex}`, stack));
    });
    return nodes;
  }

  private readListElement(element: ts.Expression): CompileValue {
    const literal = this.tryParseIntegerLiteral(element);
    if (literal !== undefined) return { kind: "int", value: literal };
    if (ts.isStringLiteral(element)) return { kind: "string", value: element.text };
    this.fail(element, "list elements must be integer or string literals");
  }

  private readSingleReturn(block: ts.Block, diagnosticNode: ts.Node): ts.Expression {
    const statement = block.statements[0];
    if (block.statements.length !== 1 || statement === undefined || !ts.isReturnStatement(statement) || statement.expression === undefined) {
      this.fail(diagnosticNode, "list callback blocks must contain exactly one return of a TSX element");
    }
    return statement.expression;
  }

  /**
   * Parse a bounded signed-int32 expression: integer literals, state and
   * prop/list identifiers, unary minus, + - * / %, and comparisons. Anything
   * outside this grammar (strings, calls, member access, floats) is rejected.
   */
  private parseExpr(expression: ts.Expression, context: ComponentContext): NativeExpr {
    if (ts.isParenthesizedExpression(expression)) return this.parseExpr(expression.expression, context);
    const literal = this.tryParseIntegerLiteral(expression);
    if (literal !== undefined) {
      return { kind: "literal", value: this.requireInt32(literal, expression, "integer literal must be a signed 32-bit integer literal") };
    }
    if (expression.kind === ts.SyntaxKind.TrueKeyword) return { kind: "literal", value: 1 };
    if (expression.kind === ts.SyntaxKind.FalseKeyword) return { kind: "literal", value: 0 };
    if (ts.isStringLiteral(expression)) {
      this.fail(expression, "runtime string values are unsupported; only compile-time-constant strings are allowed");
    }
    if (ts.isPrefixUnaryExpression(expression)) {
      if (expression.operator === ts.SyntaxKind.MinusToken) {
        return { kind: "unary", op: "neg", operand: this.parseExpr(expression.operand, context) };
      }
      if (expression.operator === ts.SyntaxKind.PlusToken) return this.parseExpr(expression.operand, context);
      this.fail(expression, "unsupported unary operator; only integer arithmetic over state is supported");
    }
    if (ts.isIdentifier(expression)) {
      const resolved = this.resolveName(expression.text, context);
      if (resolved === undefined) this.fail(expression, `unknown identifier ${expression.text} in expression`);
      if (resolved.kind === "state") return { kind: "state", stateId: resolved.binding.stateId };
      if (resolved.kind === "int") {
        return { kind: "literal", value: this.requireInt32(resolved.value, expression, "integer value must be a signed 32-bit integer to use in arithmetic") };
      }
      this.fail(expression, "string values are not valid inside an integer expression");
    }
    if (ts.isBinaryExpression(expression)) {
      const binary = this.binaryOperator(expression.operatorToken);
      const left = this.parseExpr(expression.left, context);
      const right = this.parseExpr(expression.right, context);
      if (binary.kind === "arith") return { kind: "binary", op: binary.op, left, right };
      return { kind: "compare", op: binary.op, left, right };
    }
    this.fail(expression, "unsupported expression; only integer arithmetic and comparisons over state are supported");
  }

  private binaryOperator(
    token: ts.BinaryOperatorToken,
  ): { kind: "arith"; op: BinaryOp } | { kind: "compare"; op: CompareOp } {
    switch (token.kind) {
      case ts.SyntaxKind.PlusToken:
        return { kind: "arith", op: "add" };
      case ts.SyntaxKind.MinusToken:
        return { kind: "arith", op: "sub" };
      case ts.SyntaxKind.AsteriskToken:
        return { kind: "arith", op: "mul" };
      case ts.SyntaxKind.SlashToken:
        return { kind: "arith", op: "div" };
      case ts.SyntaxKind.PercentToken:
        return { kind: "arith", op: "mod" };
      case ts.SyntaxKind.LessThanToken:
        return { kind: "compare", op: "lt" };
      case ts.SyntaxKind.LessThanEqualsToken:
        return { kind: "compare", op: "le" };
      case ts.SyntaxKind.GreaterThanToken:
        return { kind: "compare", op: "gt" };
      case ts.SyntaxKind.GreaterThanEqualsToken:
        return { kind: "compare", op: "ge" };
      case ts.SyntaxKind.EqualsEqualsToken:
      case ts.SyntaxKind.EqualsEqualsEqualsToken:
        return { kind: "compare", op: "eq" };
      case ts.SyntaxKind.ExclamationEqualsToken:
      case ts.SyntaxKind.ExclamationEqualsEqualsToken:
        return { kind: "compare", op: "ne" };
      default:
        return this.fail(token, "unsupported operator; use + - * / %, comparisons, or a state conditional");
    }
  }

  /** Fold a compile-time string concatenation (string with strings/ints) to text. */
  private tryFoldConcat(expression: ts.Expression, context: ComponentContext): string | undefined {
    if (!ts.isBinaryExpression(expression) || expression.operatorToken.kind !== ts.SyntaxKind.PlusToken) return undefined;
    if (!this.hasStringOperand(expression, context)) return undefined;
    return this.constText(expression, context);
  }

  private hasStringOperand(expression: ts.Expression, context: ComponentContext): boolean {
    if (ts.isParenthesizedExpression(expression)) return this.hasStringOperand(expression.expression, context);
    if (ts.isStringLiteral(expression)) return true;
    if (ts.isIdentifier(expression)) return this.resolveName(expression.text, context)?.kind === "string";
    if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      return this.hasStringOperand(expression.left, context) || this.hasStringOperand(expression.right, context);
    }
    return false;
  }

  private constText(expression: ts.Expression, context: ComponentContext): string | undefined {
    if (ts.isParenthesizedExpression(expression)) return this.constText(expression.expression, context);
    const literal = this.tryParseIntegerLiteral(expression);
    if (literal !== undefined) return literal.toString();
    if (ts.isStringLiteral(expression)) return expression.text;
    if (ts.isIdentifier(expression)) {
      const resolved = this.resolveName(expression.text, context);
      if (resolved?.kind === "int") return resolved.value.toString();
      if (resolved?.kind === "string") return resolved.value;
      return undefined;
    }
    if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = this.constText(expression.left, context);
      const right = this.constText(expression.right, context);
      return left === undefined || right === undefined ? undefined : left + right;
    }
    return undefined;
  }

  private resolveName(name: string, context: ComponentContext): CompileValue | undefined {
    const bound = context.env.get(name);
    if (bound !== undefined) return bound;
    const state = context.statesBySourceName.get(name);
    if (state !== undefined) return { kind: "state", binding: state };
    return undefined;
  }

  private requireNoAttributes(opening: ts.JsxOpeningLikeElement, name: string): void {
    if (opening.attributes.properties.length > 0) this.fail(opening.attributes, `${name} does not accept props in this MVP`);
  }

  private requireOnlyAttributes(opening: ts.JsxOpeningLikeElement, allowed: readonly string[]): void {
    const allowedSet = new Set(allowed);
    for (const property of opening.attributes.properties) {
      if (!ts.isJsxAttribute(property)) this.fail(property, "spread JSX attributes are unsupported");
      const propertyName = ts.isIdentifier(property.name) ? property.name.text : property.name.getText(this.sourceFile);
      if (!allowedSet.has(propertyName)) this.fail(property.name, `unsupported ${propertyName} prop`);
    }
  }

  private readStringAttribute<T extends string>(
    opening: ts.JsxOpeningLikeElement,
    name: string,
    fallback: T,
    allowedValues: readonly T[],
  ): T {
    const attribute = this.findAttribute(opening, name);
    if (attribute === undefined) return fallback;
    const value = this.parseStringValue(attribute.initializer, attribute);
    if (!allowedValues.includes(value as T)) this.fail(attribute, `${name} must be one of ${allowedValues.join(", ")}`);
    return value as T;
  }

  private readNonNegativeIntegerAttribute(opening: ts.JsxOpeningLikeElement, name: string, fallback: number): number {
    const attribute = this.findAttribute(opening, name);
    if (attribute === undefined) return fallback;
    const value = this.tryParseIntegerLiteralFromInitializer(attribute.initializer);
    if (value === undefined || value < 0n || value > MAX_INT32) {
      this.fail(attribute, `${name} must be a non-negative signed 32-bit integer literal`);
    }
    return Number(value);
  }

  private parseStringValue(initializer: ts.JsxAttributeValue | undefined, node: ts.Node): string {
    if (initializer === undefined) this.fail(node, "attribute requires a string literal");
    if (ts.isStringLiteral(initializer)) return initializer.text;
    if (ts.isJsxExpression(initializer) && initializer.expression !== undefined && ts.isStringLiteral(initializer.expression)) {
      return initializer.expression.text;
    }
    this.fail(node, "attribute requires a string literal");
  }

  private findAttribute(opening: ts.JsxOpeningLikeElement, name: string): ts.JsxAttribute | undefined {
    for (const property of opening.attributes.properties) {
      if (ts.isJsxSpreadAttribute(property)) this.fail(property, "spread JSX attributes are unsupported");
      if (ts.isIdentifier(property.name) && property.name.text === name) return property;
    }
    return undefined;
  }

  private jsxTagName(tagName: ts.JsxTagNameExpression): string {
    if (ts.isIdentifier(tagName)) return tagName.text;
    this.fail(tagName, "namespaced and member-expression JSX tags are unsupported");
  }

  private isWhitespaceJsxText(child: ts.JsxChild): boolean {
    // TypeScript normalizes whitespace-only JSX text nodes to an empty text
    // span. Non-whitespace text is handled by the leaf parser, so trimming is
    // unnecessary here and would obscure that parser boundary.
    return ts.isJsxText(child) && child.getText(this.sourceFile).length === 0;
  }

  private tryParseIntegerLiteralFromInitializer(initializer: ts.JsxAttributeValue | undefined): bigint | undefined {
    if (initializer === undefined) return undefined;
    if (ts.isStringLiteral(initializer)) return undefined;
    if (ts.isJsxExpression(initializer) && initializer.expression !== undefined) {
      return this.tryParseIntegerLiteral(initializer.expression);
    }
    return undefined;
  }

  private parseInitialInteger(expression: ts.Expression): number {
    const value = this.tryParseIntegerLiteral(expression);
    if (value === undefined) {
      this.fail(expression, "useState initial value must be a signed 32-bit integer literal");
    }
    return this.requireInt32(value, expression, "useState initial value must be a signed 32-bit integer literal");
  }

  /** Enforce the signed 32-bit range on an already-parsed integer literal. */
  private requireInt32(value: bigint, node: ts.Node, message: string): number {
    if (value < MIN_INT32 || value > MAX_INT32) this.fail(node, message);
    return Number(value);
  }

  private tryParseIntegerLiteral(expression: ts.Expression): bigint | undefined {
    if (ts.isNumericLiteral(expression)) {
      const sourceText = expression.getText(this.sourceFile);
      if (!/^\d+$/.test(sourceText)) return undefined;
      try {
        return BigInt(sourceText);
      } catch {
        return undefined;
      }
    }
    if (ts.isPrefixUnaryExpression(expression) && (expression.operator === ts.SyntaxKind.MinusToken || expression.operator === ts.SyntaxKind.PlusToken)) {
      const inner = this.tryParseIntegerLiteral(expression.operand);
      if (inner === undefined) return undefined;
      return expression.operator === ts.SyntaxKind.MinusToken ? -inner : inner;
    }
    return undefined;
  }

  private childIndex(path: string): number {
    const match = /_(\d+)$/.exec(path);
    return match === null ? 0 : Number(match[1]);
  }

  private isIgnorableDeclaration(statement: ts.Statement): boolean {
    return ts.isInterfaceDeclaration(statement)
      || ts.isTypeAliasDeclaration(statement)
      || ts.isEmptyStatement(statement)
      || (ts.isVariableStatement(statement) && (statement.declarationList.flags & ts.NodeFlags.Const) !== 0 && statement.declarationList.declarations.every((declaration) => declaration.initializer === undefined));
  }

  private hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
    return (ts.canHaveModifiers(node) ? ts.getModifiers(node) ?? [] : []).some((modifier) => modifier.kind === kind);
  }

  private fail(node: ts.Node, detail: string): never {
    const start = node.getStart(this.sourceFile);
    const location = this.sourceFile.getLineAndCharacterOfPosition(start);
    throw new SourceCompileError(this.sourceFile.fileName, location.line + 1, location.character + 1, detail);
  }
}

function sanitize(value: string): string {
  const result = value.replace(/[^A-Za-z0-9_]/g, "_");
  return /^[A-Za-z_]/.test(result) ? result : `_${result}`;
}

function clampInt32(value: bigint): number {
  if (value > MAX_INT32) return Number(MAX_INT32);
  if (value < MIN_INT32) return Number(MIN_INT32);
  return Number(value);
}

/** Evaluate an expression with no state reads to its int32 value, matching the emitter. */
function evalConstExpr(expr: NativeExpr): number | undefined {
  switch (expr.kind) {
    case "literal":
      return expr.value;
    case "state":
      return undefined;
    case "unary": {
      const operand = evalConstExpr(expr.operand);
      return operand === undefined ? undefined : clampInt32(-BigInt(operand));
    }
    case "binary": {
      const left = evalConstExpr(expr.left);
      const right = evalConstExpr(expr.right);
      if (left === undefined || right === undefined) return undefined;
      return evalBinary(expr.op, BigInt(left), BigInt(right));
    }
    case "compare": {
      const left = evalConstExpr(expr.left);
      const right = evalConstExpr(expr.right);
      if (left === undefined || right === undefined) return undefined;
      return evalCompare(expr.op, left, right);
    }
  }
}

function evalBinary(op: BinaryOp, left: bigint, right: bigint): number {
  switch (op) {
    case "add":
      return clampInt32(left + right);
    case "sub":
      return clampInt32(left - right);
    case "mul":
      return clampInt32(left * right);
    case "div":
      // BigInt division has no overflow; clamp reproduces the emitter's
      // saturation of INT32_MIN / -1 to INT32_MAX.
      if (right === 0n) return 0;
      return clampInt32(left / right);
    case "mod":
      // BigInt modulo already yields 0 for x % -1, matching the guarded helper.
      if (right === 0n) return 0;
      return clampInt32(left % right);
  }
}

function evalCompare(op: CompareOp, left: number, right: number): number {
  switch (op) {
    case "lt":
      return left < right ? 1 : 0;
    case "le":
      return left <= right ? 1 : 0;
    case "gt":
      return left > right ? 1 : 0;
    case "ge":
      return left >= right ? 1 : 0;
    case "eq":
      return left === right ? 1 : 0;
    case "ne":
      return left !== right ? 1 : 0;
  }
}
