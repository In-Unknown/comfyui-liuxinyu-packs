import importlib.util
import os
import sys

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

current_dir = os.path.dirname(__file__)

# Shared helper uses the same import name in ComfyUI and standalone tests.
if "liuxinyu_cache" not in sys.modules:
    cache_spec = importlib.util.spec_from_file_location("liuxinyu_cache", os.path.join(current_dir, "liuxinyu_cache.py"))
    cache_module = importlib.util.module_from_spec(cache_spec)
    sys.modules["liuxinyu_cache"] = cache_module
    cache_spec.loader.exec_module(cache_module)

# 自动扫描当前目录下的所有 .py 文件并加载节点
for filename in sorted(os.listdir(current_dir)):
    if not filename.endswith(".py") or filename.startswith("__") or filename == "liuxinyu_cache.py":
        continue
    
    module_name = filename[:-3]
    full_module_name = f"_liuxinyu_{module_name}"
    
    if full_module_name in sys.modules:
        continue

    file_path = os.path.join(current_dir, filename)
    spec = importlib.util.spec_from_file_location(full_module_name, file_path)
    if spec is None or spec.loader is None:
        continue
    
    module = importlib.util.module_from_spec(spec)
    sys.modules[full_module_name] = module
    try:
        spec.loader.exec_module(module)
    except Exception as e:
        print(f"[comfyui-liuxinyu-packs] Error loading {filename}: {e}")
        continue

    for attr_name in dir(module):
        obj = getattr(module, attr_name)
        if not isinstance(obj, type):
            continue
            
        # 判断 V3 API (io.ComfyNode)
        if hasattr(obj, "define_schema") and hasattr(obj, "execute"):
            try:
                schema = obj.define_schema()
                node_id = getattr(schema, "node_id", None)
                if node_id:
                    display_name = getattr(schema, "display_name", node_id)
                    NODE_CLASS_MAPPINGS[node_id] = obj
                    NODE_DISPLAY_NAME_MAPPINGS[node_id] = display_name
            except Exception:
                pass
                
        # 判断 V1 API
        elif hasattr(obj, "INPUT_TYPES") and hasattr(obj, "FUNCTION"):
            node_id = obj.__name__
            display_name = getattr(obj, "DISPLAY_NAME", node_id)
            NODE_CLASS_MAPPINGS[node_id] = obj
            NODE_DISPLAY_NAME_MAPPINGS[node_id] = display_name

WEB_DIRECTORY = "."

print(f"[comfyui-liuxinyu-packs] Loaded {len(NODE_CLASS_MAPPINGS)} nodes.")
