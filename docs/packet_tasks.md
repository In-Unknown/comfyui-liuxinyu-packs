# 分包子流

分包起点只接受执行列表，每个执行项经过完整子流并回归后，再处理下一项。普通数组先接“将任意数组转为执行列表”；要将完整值作为一包，先接“批量任意为执行列表”（次数 1）。

- [分包执行子流回归：输入输出、完整接线、配对与嵌套](LiuxinyuPacketStart.md)
- [回归分包子流条件：等待与汇总结果](LiuxinyuPacketEnd.md)
- [分包跳回：逐包携带上一轮完整数据](LiuxinyuPacketReturnStart.md)
- [携包条件回归：继续条件与最后结果](LiuxinyuPacketReturnEnd.md)

数据形式的区别见[数组、执行列表与图片批次](DataLists.md)。
