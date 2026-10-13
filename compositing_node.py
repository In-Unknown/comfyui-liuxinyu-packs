"""遮罩区域图片排列组合节点。

输入 N 张同尺寸候选图与一张遮罩，穷举所有「底图 i + 遮罩区域贴入图 j」的
有序对合成，一次输出全部组合批次，并给出与批次逐张对齐的组合索引文本。

典型用途：同一张漫画分镜生成 N 个候选后，在某个分镜区域内穷举替换方案，
从中挑选局部最优。
"""

import torch
import torch.nn.functional as F

from comfy_api.latest import io


class ImageMaskCombinations(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        # 动态生长端口：image0 必填（实心），每连接一个就自动长出下一个可选端口（空心），
        # 与核心「批量图片」(BatchImagesNode) 的交互方式完全一致。
        image_template = io.Autogrow.TemplatePrefix(
            io.Image.Input("image"),
            prefix="image",
            min=1,
            max=50,
        )
        return io.Schema(
            node_id="ImageMaskCombinations",
            display_name="遮罩区域图片排列组合",
            category="image/compositing",
            search_aliases=[
                "image combinations",
                "mask combine candidates",
                "排列组合",
                "遮罩合成",
                "候选组合",
            ],
            description=(
                "输入多张同尺寸候选图和一张遮罩，穷举所有有序对 (i,j)："
                "以图 i 为底，把图 j 贴入遮罩区域。输出全部合成结果批次，"
                "并同步输出逐张对应的组合索引（如 0->2）。"
            ),
            inputs=[
                io.Autogrow.Input(
                    "images",
                    template=image_template,
                    display_name="候选图片",
                    tooltip=(
                        "候选图片批次来源。第一个端口为必填，之后每连接一个端口，"
                        "下方会自动出现新的可选端口。所有图片必须同尺寸。"
                    ),
                ),
                io.Mask.Input(
                    "mask",
                    display_name="遮罩",
                    tooltip="白色区域表示用「贴入图」替换的部分，黑色保留底图，灰阶为半透明混合。尺寸不同会自动缩放。",
                ),
                io.Boolean.Input(
                    "include_self",
                    display_name="包含自身组合",
                    default=False,
                    tooltip="开启后输出 N×N 个组合（含 i=j 的原图对照）；关闭时输出 N×(N-1) 个，对角线的原图组合被排除。",
                ),
            ],
            outputs=[
                io.Image.Output(id="images", display_name="合成图片"),
                io.String.Output(
                    id="indices",
                    display_name="组合索引",
                    is_output_list=True,
                    tooltip="字符串列表，与输出图片批次逐张对齐，格式为「底图->贴入图」，图片编号从 0 开始。",
                ),
            ],
        )

    @classmethod
    def execute(cls, images: io.Autogrow.Type, mask: torch.Tensor, include_self: bool = False):
        # images 是 {端口名: tensor} 字典，端口名形如 image0/image1...；
        # 按末尾数字排序恢复用户在节点上的连接顺序。
        ordered = sorted(
            images.items(),
            key=lambda kv: int(kv[0][len("image"):]) if kv[0].startswith("image") and kv[0][len("image"):].isdigit() else 0,
        )
        tensors = [t for _, t in ordered if t is not None]
        if len(tensors) < 2:
            raise ValueError("至少需要连接 2 张候选图片（当前 %d 张）" % len(tensors))

        # 每个端口本身也可能是多图批次，统一拍平合并
        batch = torch.cat([t for t in tensors if t.shape[0] > 0], dim=0)
        n, h, w, c = batch.shape
        if n < 2:
            raise ValueError("合并后至少需要 2 张图片，实际只有 %d 张" % n)

        # 遮罩规整：[H,W] 或 [B,H,W] → 取第一张 → 对齐图片尺寸 → [0,1]
        if mask.dim() == 3:
            mask = mask[0]
        if mask.dim() != 2:
            raise ValueError("mask 必须是二维 [H,W] 或三维 [B,H,W] 张量")
        if mask.shape != (h, w):
            mask = F.interpolate(
                mask[None, None].float(),
                size=(h, w),
                mode="nearest",
            )[0, 0]
        mask = mask.clamp(0.0, 1.0).to(dtype=batch.dtype, device=batch.device)

        # 向量化穷举：
        #   grid[i,j] = image_i * (1-mask) + image_j * mask
        base = batch[:, None]                        # [N,1,H,W,C]
        patch = batch[None]                         # [1,N,H,W,C]
        m = mask[None, None, :, :, None]            # [1,1,H,W,1]
        grid = base * (1.0 - m) + patch * m         # [N,N,H,W,C]

        # 行优先展平：顺序为 (0,0),(0,1),...,(0,N-1),(1,0),...
        flat = grid.reshape(n * n, h, w, c)
        eye = torch.eye(n, dtype=torch.bool, device=batch.device).reshape(-1)
        keep = torch.ones(n * n, dtype=torch.bool, device=batch.device)
        if not include_self:
            keep &= ~eye
        result = flat[keep]

        # 与批次逐张对齐的索引文本
        indices = []
        for i in range(n):
            for j in range(n):
                if i == j and not include_self:
                    continue
                indices.append(f"{i}->{j}")

        summary = (
            f"候选 {n} 张，输出 {len(indices)} 个组合"
            f"（{'N×N 含自身对照' if include_self else 'N×(N-1) 已排除自身'}）\n"
            + ", ".join(indices)
        )
        return io.NodeOutput(result, indices, ui={"text": [summary]})
