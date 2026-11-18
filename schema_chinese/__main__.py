"""python -m schema_chinese schema.json --output requirements.txt"""

import argparse
import json
from pathlib import Path

from . import DescriptionError, describe


def main():
    parser = argparse.ArgumentParser(description="将 Draft 2020-12 JSON Schema 确定性地翻译为中文要求。")
    parser.add_argument("schema", type=Path)
    parser.add_argument("--output", type=Path, help="输出 UTF-8 文件；省略时打印到标准输出")
    parser.add_argument("--resources", type=Path, help="外部资源 JSON 文件，格式为 URI 到 Schema 的映射；不自动联网")
    args = parser.parse_args()
    try:
        result = describe(args.schema.read_text(encoding="utf-8-sig"),
                          resources=json.loads(args.resources.read_text(encoding="utf-8-sig")) if args.resources else None)
        if args.output:
            args.output.write_text(result.text + "\n", encoding="utf-8")
        else:
            print(result.text)
    except (DescriptionError, OSError, ValueError) as error:
        parser.exit(1, f"无法生成要求：{error}\n")
    if not result.complete:
        parser.exit(2, "描述包含未解析引用；请提供缺少的 resources。\n")


if __name__ == "__main__":
    main()
