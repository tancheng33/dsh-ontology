# dsh-ontology

[English](README.md) | 中文

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的**本体论**插件：一层带类型约束、可推理、跨会话持久的领域知识——由 Agent 自己声明词汇、按约束写入事实、再查询回来。

大多数 Agent 记忆本质是一袋字符串：写进去是散文，读出来还是散文，没有任何机制告诉它——刚记下的这条，和上周记的那条是矛盾的。这个插件给 Agent 的是**一套它必须遵守的词汇**：你先声明世界上有哪些类别、它们之间可以有什么关系，之后每一条断言都要先过这套模型的检查才能落盘；而能从已有事实推出来的事实，不必重复记录，查询时自动导出。

```
ontology_define   声明类与带类型的关系   （TBox，本体层）
ontology_assert   记录实体与事实         （ABox，写入前校验）
ontology_query    查询、遍历、推理
ontology_retract  删除，带依赖保护
```

## 为什么要 TBox，而不是一个笔记文件

| | 散文式记忆 | dsh-ontology |
|---|---|---|
| 结构 | 自由文本 | 类、带类型的关系、实体、三元组 |
| 错误输入 | 静默存下 | 拒绝，并指出违反了哪条约束 |
| 隐含事实 | 手工重述，逐渐漂移 | 由 `transitive` / `symmetric` / `inverseOf` 在读取时导出 |
| 撤回 | 孤儿文本留在原地 | 事实随实体级联删除；导出的事实随前提消失 |
| 读回来 | grep 然后碰运气 | 按类查（含子类）、三元组模式匹配、邻域展开、最短路径 |

约束本身就是价值所在。当 Agent 断言 `ada depends_on api`，而 `depends_on` 被声明为 `Component -> Component` 时，它得到的是：

```
REJECTED ada depends_on api: ada is not in the domain of depends_on
  (requires one of: Component; has: Person)
```

这是一个真信号——要么这条断言是错的，要么这个领域模型还不完整。散文式记忆两者都给不出来。

## 安装

```sh
dsh plugin --profile <名字> add dsh-ontology
dsh --profile <名字>
```

也可以从本地检出或 git 源安装：

```sh
dsh plugin --profile <名字> add ./dsh-ontology
dsh plugin --profile <名字> add github:tancheng33/dsh-ontology
```

> `github:` 安装会从源码构建，pnpm ≥10 需要显式放行构建：在 profile 的 `pnpm-workspace.yaml` 里加 `allowBuilds: { dsh-ontology: true }` 后重跑；并且建议锁定 commit（`#<sha>`），以免后续推送悄悄改变你机器上实际运行的代码。从 npm 安装不需要任何放行。

本体通过 storage 栈（`dsh-storage` + `dsh-storage-json` + `dsh-storage-domain`）持久化，这套栈从 **dsh 0.1.5** 起由 `dsh-base` 自带，所以 bundle 只贡献自己的 `ontology` 一行。因此需要 dsh ≥ 0.1.5-rc.2；更老的 harness 请自行在 profile patch 里补上那三行 storage。数据落在 `$DSH_HOME/storages/<domain>.json`。

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖任意一项：

| 键 | 默认值 | 含义 |
|---|---|---|
| `domain` | `ontology` | 存储域名；一个名字 = 一张独立图谱。须匹配 `/^[a-z][a-z0-9_]*$/`。 |
| `strict` | `true` | 拒绝违反词汇约束的事实。设为 `false` 则照样存下，但把违规记录在事实上，适合探索式建模。 |
| `inference` | `true` | 允许查询返回推导出的事实。 |
| `promptSection` | `true` | 把词汇摘要注入系统提示词。 |
| `promptMaxTerms` | `60` | 摘要中词条数量上限。 |
| `promptOrder` | `150` | 该段落在系统提示词中的位置。 |
| `defaultLimit` / `maxLimit` | `50` / `500` | 查询结果规模。 |
| `maxEntities` / `maxFacts` | `20000` / `100000` | 容量护栏；超出的写入会明确失败。 |

想跑两张互相隔离的图谱，插两行就行：

```yaml
- insert:
    - id: ontology-team
      name: dsh-ontology
      config: { domain: team_ontology, strict: true, inference: true, promptSection: true,
                promptMaxTerms: 60, promptOrder: 150, defaultLimit: 50, maxLimit: 500,
                maxEntities: 20000, maxFacts: 100000 }
```

（patch 会整体替换一行的 `config`，所以每个键都要写全。）

## 一个完整例子

**先声明词汇。** 顺序无所谓——内部会反复重试直到收敛，所以子类可以写在父类前面，关系也可以写在它的逆关系前面。

```jsonc
// ontology_define
{
  "classes": [
    { "id": "Service", "subClassOf": ["Component"] },
    { "id": "Component", "comment": "系统中一个可部署单元" },
    { "id": "Person" }
  ],
  "relations": [
    { "id": "depends_on", "domain": ["Component"], "range": ["Component"],
      "characteristics": ["transitive"] },
    { "id": "owns", "domain": ["Person"], "range": ["Component"], "inverseOf": "owned_by" },
    { "id": "owned_by", "domain": ["Component"], "range": ["Person"] },
    { "id": "version", "domain": ["Component"], "rangeKind": "literal" }
  ]
}
```

**再写入实例。** 同一次调用里实体先于事实创建，所以一次调用就能把一个个体和它的关系一起引入。

```jsonc
// ontology_assert
{
  "entities": [
    { "id": "api", "classes": ["Service"] },
    { "id": "auth", "classes": ["Service"] },
    { "id": "pg", "classes": ["Component"] },
    { "id": "ada", "classes": ["Person"] }
  ],
  "facts": [
    { "subject": "api", "predicate": "depends_on", "object": "auth" },
    { "subject": "auth", "predicate": "depends_on", "object": "pg" },
    { "subject": "ada", "predicate": "owns", "object": "api", "source": "CODEOWNERS" },
    { "subject": "api", "predicate": "version", "object": "2.1.0" }
  ]
}
```

**查询——包括从没写进去过的那些。**

```jsonc
// ontology_query
{ "mode": "facts", "subject": "api", "predicate": "depends_on", "includeInferred": true }
```

```
api depends_on auth
api depends_on pg (inferred: transitive)
```

```jsonc
// ontology_query
{ "mode": "path", "from": "ada", "to": "pg", "depth": 4 }
```

```
connected in 3 step(s):
  ada owns api
  api depends_on auth
  auth depends_on pg
```

## 查询模式

| 模式 | 回答什么问题 |
|---|---|
| `schema` | 现在有哪些词汇？（不确定时从这里开始） |
| `stats` | 图谱多大，有多少是可推导的？ |
| `entities` | 哪些个体属于类 X（含其子类），或文本匹配 Y？ |
| `facts` | 哪些三元组匹配这个模式？省略的位置即通配符。 |
| `neighbors` | 这个实体周围 N 跳内有什么？ |
| `path` | 这两个实体是怎么连起来的？ |

## 它强制的规则

**包含关系（Subsumption）。** `subClassOf` 是传递的：声明为 `Service` 的实体同时也是 `Component`，因此满足 `Component` 的 domain 约束，也会被 `Component` 查询命中。定义时拒绝成环——一旦成环，环上每个类的"是不是 X"都变得不可证伪。

**Domain 与 Range。** 关系的 `domain` 约束主语、`range` 约束宾语，两者都在包含闭包下判定。空列表表示不约束——这是"尚未决定"的诚实编码，而不是悄悄的全部放行。

**实体 vs 字面量。** `rangeKind: "literal"` 让关系变成属性型（版本号、日期）。字面量型关系不能是对称的、传递的，也不能有逆关系——否则推出的三元组会把一个字面量放在主语位置。这种不自洽在定义时就被拒绝，而不是等到后面产生垃圾数据。

**函数型基数。** `functional` 关系对同一主语最多只允许一个宾语。第二个不同的宾语会报 `functional-conflict`，而不是静默覆盖。重复断言**同一个**宾语则保持幂等。

**推理。** `transitive`、`symmetric`、`inverseOf` 会迭代到不动点，因此规则可以复合（传递关系的逆关系本身也做传递闭包）。推导出的事实**只在读取时导出，从不落盘**——撤回一个前提，所有依赖它的推论一并消失，不会留下过期派生数据。每条推论都带 `via` 标明是哪条规则产生的。

**撤回安全。** 撤回实体会级联删除所有提到它的事实。撤回**词条**时，只要还有东西依赖它就会被拒绝——比如某个类还在给实体分类、还出现在某个关系的签名里，或某个关系还有事实在用——并且拒绝信息里会指出是谁在依赖它。

## Code Mode

每个工具都能作为带类型的函数调用，拿到的是规范 JSON 值（而不是渲染出来的散文）：

```ts
const { facts } = await tools.ontology_query({
  mode: 'facts', predicate: 'depends_on', includeInferred: true,
})
const upstream = facts.filter(fact => fact.via === 'transitive').map(fact => fact.object)
```

## 单独使用推理内核

规则引擎是纯函数——不碰 IO、不碰存储、不依赖 Cordis——并且单独导出了入口，可以脱离 harness 使用：

```ts
import { entail, findPath, validateFactInput } from 'dsh-ontology/ontology'
```

## 开发

```sh
pnpm install
pnpm test        # 47 个单测：规则、工具、提示词段落
pnpm typecheck
pnpm build
```

`tests/memory-domain.ts` 是一个内存版的存储域替身，因此 store 和工具是端到端测的——真校验、真推理、真工具返回值——不需要任何后端。

## 环境要求

- DeepSeek Harness `>= 0.1.0-rc.6`
- Node `^22.19 || >=24`

## 许可

MIT
