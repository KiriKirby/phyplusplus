# Phy++ for Phytozome

为 [Phytozome Next](https://phytozome-next.jgi.doe.gov/) 提供更高效的物种检索与 BLAST 结果处理功能的 Tampermonkey 脚本。

Phy++ 直接扩展 Phytozome 原有的 BLAST **AG Grid** 表格，不会用自定义表格替换网站本身的结果表。因此，网站原有的排序、筛选、勾选和其他表格功能仍可正常使用。

## 功能

### 物种搜索

- 在停止输入短暂延迟后，物种搜索建议会追加简短发布日期（`YYYY.MM.DD`）及内部 `id...`。
- 不改写 React 管理的原始搜索文本，不影响继续输入或搜索行为。

### BLAST 结果表格

- 将 **Identity** 调整到 **E-value** 后面。
- 新增 **Query Coverage** 列，计算方式为 `align_len / query_length * 100`。
  - 单元格仅显示可筛选的数值，不附加 `%` 字符号。
- 扩展 **View** 列宽度，确保原有按钮和新增按钮能够同时显示。
- 新增 **Link** 列，显示绿色 `G` 按钮所打开的 Phytozome 蛋白报告页地址。
- 新增 **Peptide sequence** 列，显示对应蛋白报告中的肽序列内容，不包含标题。
- 在 **View** 列加入绿色 `F` 按钮，可将完整的 FASTA 格式肽序列（包含原始标题）复制到剪贴板。

当使用 **Protein** 列排序时，脚本会通过 Phytozome 的基因 API 判断是否属于同一个实际基因标识符（`primaryidentifier`）。属于同一组的蛋白名称会标红。该判断不依赖蛋白命名规则，因此适用于不同物种和不同命名体系。

### Phy++ output

在原有导出/重置结果控件旁加入 **Phy++ output** 下拉菜单，可对当前勾选的行进行操作，并保持表格中的从上到下顺序：

- **Export FASTA**：导出完整 FASTA 肽序列；每个序列之间保留一个空行。
- **Export table**：将勾选的原生表格行导出为 Excel 工作簿。

两种导出均会调用浏览器的“另存为”文件对话框，且不会预设文件名或自动下载。

## 性能与数据来源

- 肽序列、蛋白报告和版本分组数据会在当前页面会话中缓存。
- 表格显示、复制、FASTA 导出和 Excel 导出会复用已获取的数据。
- 同时请求的蛋白报告数量受限，以避免 BLAST 结果页面卡顿或无响应。

## 使用要求

- 建议使用最新版 Chrome、Microsoft Edge 或其他 Chromium 浏览器。
- 导出时的“另存为”对话框依赖 Chromium 的 File System Access API。
- 使用前需要已安装 [Tampermonkey](https://www.tampermonkey.net/)。

## 源代码与反馈

- 项目主页：[KiriKirby/phyplusplus](https://github.com/KiriKirby/phyplusplus)
- 问题反馈：[GitHub Issues](https://github.com/KiriKirby/phyplusplus/issues)
- 许可证：MIT
