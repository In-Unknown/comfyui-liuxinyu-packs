// UI hints only. The original, unmodified schema is validated by Draft202012Validator.
export const cloneJSON = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
export const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

export function resolveSchema(schema, root, seen = new Set()) {
  if (typeof schema === "boolean") return schema;
  if (!schema || typeof schema !== "object") throw new Error("字段 Schema 必须是对象或布尔值");
  if (!schema.$ref) return schema;
  const ref = schema.$ref;
  if (seen.has(ref)) return { ...schema, _rawReason: "递归引用按当前填写值逐层展开；确认时按原始 Schema 校验。" };
  let target;
  if (ref === "#") target = root;
  else if (ref.startsWith("#/")) {
    target = root;
    for (const part of decodeURIComponent(ref.slice(2)).split("/")) {
      const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
      if (!target || !own(target, key)) throw new Error(`找不到 Schema 引用 ${ref}`);
      target = target[key];
    }
  } else {
    return { ...schema, _rawReason: "引用由后端按资源作用域解析，解析完成后显示字段控件。" };
  }
  const siblings = Object.keys(schema).filter(key => !["$ref", "title", "description", "default", "$comment"].includes(key));
  if (siblings.length) return { ...schema, _rawReason: "$ref 与同级约束共同参与表单生成及最终校验。" };
  const resolved = resolveSchema(target, root, new Set([...seen, ref]));
  return typeof resolved === "boolean" ? resolved : { ...resolved, ...Object.fromEntries(
    ["title", "description", "default"].filter(key => own(schema, key)).map(key => [key, schema[key]])) };
}

export function rawReason(schema) {
  if (schema?._rawReason) return schema._rawReason;
  if (schema && ["$dynamicRef", "allOf", "if", "then", "else", "dependentSchemas", "patternProperties", "$id"]
    .some(key => own(schema, key))) return "组合、条件或引用规则由后端解析，解析完成后显示字段控件。";
  return "";
}

export function typesOf(schema, value) {
  if (schema === true) return ["object", "array", "string", "number", "boolean", "null"];
  if (schema === false) return [];
  if (Array.isArray(schema.type)) return schema.type;
  if (schema.type) return [schema.type];
  // Keywords such as properties/format/minimum do not assert a JSON type.
  const types=["object", "array", "string", "number", "boolean", "null"];
  const preferred=schema.properties||schema.required||own(schema,"additionalProperties")?"object":schema.items||schema.prefixItems||own(schema,"minItems")?"array":schema.format||schema.pattern||own(schema,"minLength")?"string":own(schema,"minimum")||own(schema,"maximum")||schema.multipleOf?"number":null;
  return preferred?[preferred,...types.filter(type=>type!==preferred)]:types;
}

export function valueType(value) {
  return value === null ? "null" : Array.isArray(value) ? "array" : typeof value === "number" && Number.isInteger(value) ? "integer" : typeof value;
}

export function itemSchema(schema, index) {
  return index < (schema.prefixItems?.length || 0) ? schema.prefixItems[index] : schema.items ?? true;
}

// JSON Schema has no Vector3 type. Recognize an explicitly numeric axis object
// for presentation only; never change its JSON shape or validation rules.
export function vectorComponents(input, value, root) {
  const schema = resolveSchema(input, root);
  if (rawReason(schema) || schema?.type !== "object" || !value || Array.isArray(value)) return null;
  const keys = Object.keys(schema.properties || {});
  if (keys.length < 2 || keys.length > 4 || Object.keys(value).length !== keys.length) return null;
  if (schema.additionalProperties !== false || !keys.every(key => schema.required?.includes(key))) return null;
  const axes = ["x", "y", "z", "w"].slice(0, keys.length);
  if (!axes.every(axis => keys.some(key => key.toLowerCase() === axis))) return null;
  const ordered = axes.map(axis => keys.find(key => key.toLowerCase() === axis));
  return ordered.every(key => {
    const child = resolveSchema(schema.properties[key], root);
    return own(value, key) && typeof value[key] === "number" && !rawReason(child)
      && !child.enum && !own(child, "const") && ["number", "integer"].includes(child.type);
  }) ? ordered : null;
}

export function initialValue(input, root, depth = 0) {
  if (depth > 12) return null; // Recursive required containers cannot be expanded indefinitely.
  let schema;try{schema=resolveSchema(input, root);}catch{schema=true;}
  if (schema === false) return undefined;
  if (own(schema, "default")) return cloneJSON(schema.default);
  if (own(schema, "const")) return cloneJSON(schema.const);
  if (schema.enum?.length) return cloneJSON(schema.enum[0]);
  if (schema.oneOf || schema.anyOf) return initialValue((schema.oneOf || schema.anyOf)[0], root, depth + 1);
  const type = typesOf(schema)[0];
  if (type === "object") {
    const result = Object.create(null);
    for (const key of new Set([...Object.keys(schema.properties || {}),...(schema.required||[])])) {
      const child=own(schema.properties||{},key)?schema.properties[key]:schema.additionalProperties??true;
      const resolved = resolveSchema(child, root);
      if ((schema.required || []).includes(key) || own(resolved, "default") || own(resolved, "const")) {
        result[key] = initialValue(child, root, depth + 1) ?? null;
      }
    }
    return result;
  }
  if (type === "array") return Array.from({ length: Math.min(schema.minItems || 0, 100) },
    (_, i) => initialValue(itemSchema(schema, i), root, depth + 1) ?? null);
  if (type === "boolean") return false;
  if (type === "null") return null;
  if (type === "integer" || type === "number") {
    const bounds = numericBounds(schema, type);
    const candidate = bounds.min ?? (bounds.max !== undefined && bounds.max < 0 ? bounds.max : 0);
    const step = schema.multipleOf || (type === "integer" ? 1 : null);
    return step ? Number((Math.ceil(candidate / step - 1e-12) * step).toPrecision(15)) : candidate;
  }
  return "";
}

// Reconcile drafts: preserve compatible values, fill required keys, and propose
// sibling backups for type conflicts. Only the backend can approve backup keys.
export function completeRequired(input,value,root=input,branches=new Map()){
  let result=cloneJSON(value);const added=[],replaced=[],backups=[],saved=new Set();let budget=4000;
  const matchesType=(schema,current)=>{const type=valueType(current),types=typesOf(schema,current);return types.includes(type)||type==='integer'&&types.includes('number');};
  const compatible=(schema,current)=>{
    const s=resolveSchema(schema,root);if(s===false)return false;if(s===true)return true;
    if(own(s,'const')&&JSON.stringify(s.const)!==JSON.stringify(current))return false;
    if(s.enum&&!s.enum.some(v=>JSON.stringify(v)===JSON.stringify(current)))return false;
    const type=valueType(current),types=typesOf(s,current);
    if(!types.includes(type)&&!(type==='integer'&&types.includes('number')))return false;
    return !current||typeof current!=='object'||Array.isArray(current)||Object.entries(s.properties||{}).every(([key,child])=>!own(current,key)||compatible(child,current[key]));
  };
  function visit(source,current,path,depth,set=next=>result=next,owner=null){
    if(depth>32||--budget<0)return;
    let s;try{s=resolveSchema(source,root);}catch{return;}
    if(typeof s==='boolean'||rawReason(s))return; // Scoped/conditional rules use the backend presentation.
    if(!matchesType(s,current)){
      const ownerPath=owner?`${owner.path}/${String(owner.key).replace(/~/g,'~0').replace(/\//g,'~1')}`:null;
      if(owner&&!added.includes(ownerPath)&&!saved.has(ownerPath)){backups.push(cloneJSON(owner));saved.add(ownerPath);}
      current=initialValue(s,root,depth)??null;
      if(!matchesType(s,current)){
        const basic={...s};for(const key of ['default','const','enum','oneOf','anyOf'])delete basic[key];
        current=initialValue(basic,root,depth)??null;
      }
      set(current);replaced.push(path);
    }
    const choices=s.oneOf||s.anyOf;
    if(choices){
      const explicit=branches.get(path),matching=Number.isInteger(explicit)&&explicit>=0&&explicit<choices.length?[choices[explicit]]:choices.filter(child=>{try{return compatible(child,current);}catch{return false;}});
      if(matching.length===1)visit(matching[0],current,path,depth+1,set,owner);
      else if(matching.length>1){
        const resolved=matching.map(child=>resolveSchema(child,root)),required=(resolved[0].required||[]).filter(key=>resolved.every(child=>child.required?.includes(key)));
        const properties=Object.fromEntries(required.map(key=>[key,{anyOf:resolved.map(child=>child.properties?.[key]??true)}]));
        visit({required,properties},current,path,depth+1,set,owner);
      }
    }
    if(Array.isArray(current)){
      current.forEach((item,i)=>visit(itemSchema(s,i),item,`${path}/${i}`,depth+1,next=>current[i]=next,owner));return;
    }
    if(!current||typeof current!=='object')return; // A wrong type is a field error, not permission to discard data.
    for(const key of s.required||[]){
      if(own(current,key))continue;
      const child=own(s.properties||{},key)?s.properties[key]:s.additionalProperties??true;
      let initial;try{initial=initialValue(child,root,depth+1);}catch{initial=null;}
      Object.defineProperty(current,key,{value:initial??null,writable:true,enumerable:true,configurable:true});
      added.push(`${path}/${String(key).replace(/~/g,'~0').replace(/\//g,'~1')}`);
    }
    for(const [key,item] of Object.entries(current)){
      const child=own(s.properties||{},key)?s.properties[key]:s.additionalProperties??true;
      visit(child,item,`${path}/${String(key).replace(/~/g,'~0').replace(/\//g,'~1')}`,depth+1,next=>Object.defineProperty(current,key,{value:next,writable:true,enumerable:true,configurable:true}),{path,key,value:cloneJSON(item)});
    }
  }
  visit(input,result,'$',0);return {value:result,added,replaced,backups};
}

export function numericBounds(schema, type) {
  let min = schema.minimum, max = schema.maximum;
  let step = schema.multipleOf || (type === "integer" ? 1 : null);
  if (type === "integer" && step && !Number.isInteger(step)) {
    // Integer multiples of 0.3 are ..., 0, 3, 6; a 0.3 slider would offer fractions.
    const [mantissa, exponent = "0"] = String(step).split("e");
    const digits = (mantissa.split(".")[1] || "").length - Number(exponent);
    let numerator = BigInt(mantissa.replace(".", "")), denominator = 10n ** BigInt(Math.max(0, digits));
    if (digits < 0) numerator *= 10n ** BigInt(-digits);
    let a = numerator, b = denominator;
    while (b) [a, b] = [b, a % b];
    step = Number(numerator / a);
  }
  const snap = (bound, up, exclusive = false) => {
    if (!step) return undefined;
    const quotient = Number((bound / step).toPrecision(15));
    const index = exclusive ? (up ? Math.floor(quotient) + 1 : Math.ceil(quotient) - 1)
      : (up ? Math.ceil(quotient) : Math.floor(quotient));
    return Number((index * step).toPrecision(15));
  };
  if (schema.exclusiveMinimum !== undefined) {
    const limit = snap(schema.exclusiveMinimum, true, true);
    min = limit === undefined ? undefined : Math.max(min ?? -Infinity, limit);
  }
  if (schema.exclusiveMaximum !== undefined) {
    const limit = snap(schema.exclusiveMaximum, false, true);
    max = limit === undefined ? undefined : Math.min(max ?? Infinity, limit);
  }
  if (type === "integer") {
    if (min !== undefined) min = Math.ceil(min);
    if (max !== undefined) max = Math.floor(max);
  }
  if (step) {
    if (min !== undefined) min = snap(min, true);
    if (max !== undefined) max = snap(max, false);
  }
  return { min, max, step: step ?? "any", slider: Number.isFinite(min) && Number.isFinite(max) && min < max };
}
