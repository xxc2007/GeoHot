# 导入结果与时间重锚

HTTP 200 表示本批没有身份隔离，但仍应逐项读取 skipped；HTTP 202 不是整批成功入库。未知来源的 sourceStatus=pending_review 只保存来源审核证据，整批 quarantined，created/revised 均为零；已知来源的身份冲突则附 identityConflicts，按原请求 index 标识待审材料，其余未跳过条目仍可以正常接受。

CLI 使用共享的严格结果校验器，先核验计数、索引范围、唯一性，以及身份隔离索引与 skipped 的对应关系。无效或未知形状按整批拒绝处理。结果报告逐项区分 accepted、quarantined 和 rejected；只有明确接受的条目才能参与后续时间重锚。身份冲突保留原材料、原始时间和私有观察，不把待审核当作实时动态，也不因 HTTP 202 重写整批已有历史。

非成功状态、重定向、网络失败和不合法 JSON 保持失败与不重锚；所有上游错误正文均不回显。接口增加 identityConflicts 为兼容字段，不改变旧版正常 HTTP 200 或整批来源待审 HTTP 202 的语义。测试通过真实 Fastify 入口和 CLI，验证混合批次只重锚接受行、既有冲突双 ID 原文及时间完全保留。
