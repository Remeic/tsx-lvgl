import { readFileSync } from "node:fs";
import * as ts from "typescript";
import type { NativeAction, NativeNode, NativeProgram, NativeState, NativeText } from "./native-program.js";

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
  readonly state: MutableState;
}

interface MutableState {
  readonly id: string;
  readonly initial: number;
  readonly bindingIds: string[];
}

interface ComponentContext {
  readonly component: ComponentDeclaration;
  readonly instancePath: string;
  readonly statesBySourceName: Map<string, StateBinding>;
  readonly setters: Map<string, StateBinding>;
  readonly handlers: Map<string, string>;
  readonly actionIndexes: { value: number };
  hookIndex: number;
}

interface SourceProgram {
  readonly program: NativeProgram;
  readonly entryFile: string;
}

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
  private readonly states: MutableState[] = [];
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

    const states: NativeState[] = this.states.map((state) => ({
      id: state.id,
      initial: state.initial,
      bindingIds: [...state.bindingIds],
    }));
    const program: NativeProgram = {
      format: "tsx-lvgl-native-program-v0",
      root,
      states,
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
        default:
          this.fail(specifier, `unsupported @tsx-lvgl/react import ${imported}`);
      }
    }
  }

  private renderComponent(
    component: ComponentDeclaration,
    instancePath: string,
    stack: readonly string[],
  ): NativeNode {
    if (this.hasModifier(component.node, ts.SyntaxKind.AsyncKeyword)) {
      this.fail(component.node, "async components are unsupported in the fixed-tree MVP");
    }
    if (stack.includes(component.name)) {
      this.fail(component.node, `recursive component composition is unsupported (${component.name})`);
    }
    if (component.node.parameters.length > 0) {
      this.fail(component.node.parameters[0]!, "component props are not supported yet; compose zero-argument components");
    }

    const context: ComponentContext = {
      component,
      instancePath,
      statesBySourceName: new Map(),
      setters: new Map(),
      handlers: new Map(),
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
      const actionId = this.addHandler(declaration.name.text, declaration.initializer, context, declaration);
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
    const state: MutableState = {
      id: `${sanitize(context.instancePath)}_s${context.hookIndex}`,
      initial,
      bindingIds: [],
    };
    context.hookIndex += 1;
    this.states.push(state);
    const stateBinding: StateBinding = { sourceName: stateName.text, setterName: setterName.text, state };
    context.statesBySourceName.set(stateName.text, stateBinding);
    context.setters.set(setterName.text, stateBinding);
  }

  private addHandler(
    name: string,
    handler: ts.ArrowFunction,
    context: ComponentContext,
    diagnosticNode: ts.Node,
  ): string {
    const actionId = `${sanitize(context.instancePath)}_a${context.actionIndexes.value}`;
    context.actionIndexes.value += 1;
    const action = this.parseHandler(handler, context, diagnosticNode);
    this.actions[actionId] = action;
    return actionId;
  }

  private parseHandler(handler: ts.ArrowFunction, context: ComponentContext, diagnosticNode: ts.Node): NativeAction {
    if (this.hasModifier(handler, ts.SyntaxKind.AsyncKeyword)) {
      this.fail(handler, "async event handlers are unsupported in the fixed-tree MVP");
    }
    if (handler.parameters.length !== 0) this.fail(handler.parameters[0]!, "event handlers cannot receive parameters");
    const expression = ts.isBlock(handler.body)
      ? this.readSingleHandlerStatement(handler.body, handler)
      : handler.body;
    if (!ts.isCallExpression(expression) || !ts.isIdentifier(expression.expression)) {
      this.fail(diagnosticNode, "event handlers must call a local state setter");
    }
    const binding = context.setters.get(expression.expression.text);
    if (binding === undefined) this.fail(expression.expression, `unknown state setter ${expression.expression.text}`);
    if (expression.arguments.length !== 1) this.fail(expression, "state setters require exactly one update argument");
    return this.parseStateUpdate(binding, expression.arguments[0]!);
  }

  private readSingleHandlerStatement(block: ts.Block, diagnosticNode: ts.Node): ts.Expression {
    const statement = block.statements[0];
    if (block.statements.length !== 1 || statement === undefined || !ts.isExpressionStatement(statement)) {
      this.fail(diagnosticNode, "event handler blocks must contain exactly one state-setter call");
    }
    return statement.expression;
  }

  private parseStateUpdate(binding: StateBinding, update: ts.Expression): NativeAction {
    const literal = this.tryParseIntegerLiteral(update);
    if (literal !== undefined) {
      if (literal < MIN_INT32 || literal > MAX_INT32) {
        this.fail(update, "state setter integer literal must be a signed 32-bit integer literal");
      }
      return { kind: "set", stateId: binding.state.id, value: Number(literal) };
    }
    if (!ts.isArrowFunction(update)) {
      this.fail(update, "state updates must be an integer literal or previous => previous +/- integerLiteral");
    }
    if (this.hasModifier(update, ts.SyntaxKind.AsyncKeyword)) {
      this.fail(update, "async state updates are unsupported in the fixed-tree MVP");
    }
    if (update.parameters.length !== 1 || !ts.isIdentifier(update.parameters[0]!.name)) {
      this.fail(update, "functional state updates require one previous-value parameter");
    }
    const previousName = (update.parameters[0]!.name as ts.Identifier).text;
    const body = ts.isBlock(update.body)
      ? this.readSingleHandlerStatement(update.body, update)
      : update.body;
    if (!ts.isBinaryExpression(body) || !ts.isIdentifier(body.left) || body.left.text !== previousName) {
      this.fail(update, "functional state updates must use previous +/- integerLiteral");
    }
    const delta = this.tryParseIntegerLiteral(body.right);
    if (delta === undefined || delta < MIN_INT32 || delta > MAX_INT32) {
      this.fail(body.right, "functional state update delta must be a signed 32-bit integer literal");
    }
    if (body.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      return { kind: "add", stateId: binding.state.id, value: Number(delta) };
    }
    if (body.operatorToken.kind === ts.SyntaxKind.MinusToken) {
      return { kind: "subtract", stateId: binding.state.id, value: Number(delta) };
    }
    this.fail(body.operatorToken, "only + and - functional state updates are supported");
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
      if (opening.attributes.properties.length > 0) this.fail(opening.attributes, "component props are unsupported in this MVP");
      const meaningfulChildren = children.filter((child) => !this.isWhitespaceJsxText(child));
      if (meaningfulChildren.length > 0) {
        this.fail(meaningfulChildren[0]!, "component children are unsupported in this MVP; compose zero-argument components");
      }
      return this.renderComponent(component, `${path}_c${this.childIndex(path)}`, stack);
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
    if (value.kind === "state") {
      const bindingId = `${value.stateId}_b${this.stateById(value.stateId).bindingIds.length}`;
      this.stateById(value.stateId).bindingIds.push(bindingId);
      value = { ...value, bindingId };
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
      return this.addHandler("__inline", expression, context, expression);
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
    const literal = this.tryParseIntegerLiteral(expression);
    if (literal !== undefined) return { kind: "literal", value: literal.toString() };
    if (ts.isStringLiteral(expression)) return { kind: "literal", value: expression.text };
    if (ts.isIdentifier(expression)) {
      const binding = context.statesBySourceName.get(expression.text);
      if (binding === undefined) this.fail(expression, "Text bindings must reference a state variable directly");
      return { kind: "state", stateId: binding.state.id, bindingId: "" };
    }
    this.fail(expression, "Text bindings must be a direct state identifier or literal");
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
      if (ts.isJsxExpression(child)) this.fail(child, "expressions cannot be children of Screen, View, or Fragment");
      result.push(this.renderJsx(child, context, `${path}_${index}`, stack));
    }
    return result;
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
    if (value === undefined || value < MIN_INT32 || value > MAX_INT32) {
      this.fail(expression, "useState initial value must be a signed 32-bit integer literal");
    }
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

  private stateById(id: string): MutableState {
    const state = this.states.find((candidate) => candidate.id === id);
    if (state === undefined) throw new Error(`internal compiler error: unknown state ${id}`);
    return state;
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
