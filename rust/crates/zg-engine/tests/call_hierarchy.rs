//! Source-to-call-hierarchy acceptance tests adapted from upstream LSP cases.
//! These are intentionally failing until indexing produces the required graph.
//! Do not seed entities/edges, ignore cases, or treat missing graph data as success.

#[allow(dead_code)] // Reuse the existing embedding stub; other storage helpers are unused here.
mod support;

use std::{fs, path::Path};
use support::{EmbeddingServer, configure_remote_model, index_options};
use zg_engine::{
    ZvecGrep,
    api::{
        index::{IndexResult, options::WorkspaceChange},
        relationships::{
            RelationshipEdge, RelationshipOptions, RelationshipSymbol, SymbolRelationships,
        },
    },
};

struct Case {
    name: &'static str,
    files: Vec<SourceFile>,
    queries: Vec<Query>,
}

struct SourceFile {
    path: &'static str,
    source: &'static str,
}

struct Query {
    direction: &'static str,
    symbol: &'static str,
    expected: Vec<SymbolRelationships>,
}

fn sort_calls(groups: &mut [SymbolRelationships]) {
    // Upstream implementations group/order calls differently. Ignore edge order,
    // but retain duplicates and compare every endpoint, range, site and count.
    for group in groups {
        group.edges.sort_by_cached_key(|edge| {
            let symbol = edge.symbol.as_ref().expect("known upstream endpoint");
            (
                symbol.file_path.clone(),
                symbol.start_line,
                symbol.name.clone(),
                edge.line,
                edge.column,
            )
        });
    }
}

async fn check_case(case: Case) {
    let directory = tempfile::tempdir().expect("source workspace");
    let root = directory.path().canonicalize().expect("canonical root");
    for file in &case.files {
        let path = root.join(file.path);
        fs::create_dir_all(path.parent().expect("source directory")).expect("create directory");
        fs::write(path, file.source).expect("write upstream source");
    }
    // Only embeddings are stubbed. Extraction, indexing, graph resolution and
    // relationship queries must all use production code; no graph rows are seeded.
    let server = EmbeddingServer::start().expect("local embedding server");
    configure_remote_model(&root, server.address).expect("embedding configuration");
    let engine = ZvecGrep::new();
    let mut options = index_options(&root);
    options.scan.globs = Some(case.files.iter().map(|file| file.path.into()).collect());
    let indexed = engine.index(options).await.expect("index source files");
    assert_eq!(indexed.files_failed, 0, "{}: {indexed:?}", case.name);
    assert_eq!(
        indexed.files_added,
        case.files.len(),
        "{}: {indexed:?}",
        case.name
    );
    assert!(indexed.skipped.is_empty(), "{}: {indexed:?}", case.name);

    check_queries(&engine, &root, case.name, &case.queries).await;
    engine.close();
}

async fn check_queries(engine: &ZvecGrep, root: &Path, stage: &str, queries: &[Query]) {
    for query in queries {
        let options = RelationshipOptions {
            root: Some(root.to_path_buf()),
            symbol: query.symbol.into(),
            ..RelationshipOptions::default()
        };
        let result = match query.direction {
            "in" => engine.callers(options).await,
            "out" => engine.callees(options).await,
            _ => panic!("invalid query direction"),
        };
        let mut actual = result.unwrap_or_else(|error| {
            panic!("{}: {} {}: {error}", stage, query.direction, query.symbol)
        });
        let mut expected = query.expected.clone();
        sort_calls(&mut actual);
        sort_calls(&mut expected);
        assert_eq!(
            actual, expected,
            "{}: {} {}",
            stage, query.direction, query.symbol
        );
    }
}

// Expected descriptions and call sites come from the upstream examples, not index output.
fn description(name: &str, path: &str, start_line: usize, end_line: usize) -> RelationshipSymbol {
    RelationshipSymbol {
        name: name.into(),
        file_path: path.into(),
        start_line,
        end_line,
    }
}

fn relationships(
    symbol: &RelationshipSymbol,
    sites: &[(&RelationshipSymbol, u32, u32)],
) -> SymbolRelationships {
    SymbolRelationships {
        symbol: symbol.clone(),
        total_edges: sites.len(),
        edges: sites
            .iter()
            .map(|&(symbol, line, column)| RelationshipEdge {
                symbol: Some(symbol.clone()),
                line: Some(line),
                column: Some(column),
            })
            .collect(),
    }
}

// https://github.com/rust-lang/rust-analyzer/blob/3131751eaf1c3b5da6e618acdc2148ad7db65bc7/crates/ide/src/call_hierarchy.rs
// Upstream case: test_call_hierarchy_in_same_fn.
// https://github.com/rust-lang/rust-analyzer/blob/3131751eaf1c3b5da6e618acdc2148ad7db65bc7/crates/ide/src/call_hierarchy.rs
// Upstream case: test_call_hierarchy_outgoing. Strip rust-analyzer cursor/file markers. Split
// upstream grouped call ranges into one edge per site; definition ranges cover full functions.
#[tokio::test]
async fn rust_repeated_calls() {
    let target = description("callee", "lib.rs", 1, 1);
    let caller = description("caller", "lib.rs", 2, 5);
    check_case(Case {
        name: "rust_repeated_calls",
        files: vec![SourceFile {
            path: "lib.rs",
            source: "fn callee() {}\nfn caller() {\n    callee();\n    callee();\n}\n",
        }],
        queries: vec![
            Query {
                direction: "in",
                symbol: "callee",
                expected: vec![relationships(&target, &[(&caller, 3, 4), (&caller, 4, 4)])],
            },
            Query {
                direction: "out",
                symbol: "caller",
                expected: vec![relationships(&caller, &[(&target, 3, 4), (&target, 4, 4)])],
            },
            Query {
                direction: "in",
                symbol: "caller",
                expected: vec![relationships(&caller, &[])],
            },
            Query {
                direction: "out",
                symbol: "callee",
                expected: vec![relationships(&target, &[])],
            },
        ],
    })
    .await;
}

// https://github.com/rust-lang/rust-analyzer/blob/3131751eaf1c3b5da6e618acdc2148ad7db65bc7/crates/ide/src/call_hierarchy.rs
// Upstream case: test_call_hierarchy_in_different_files.
// https://github.com/rust-lang/rust-analyzer/blob/3131751eaf1c3b5da6e618acdc2148ad7db65bc7/crates/ide/src/call_hierarchy.rs
// Upstream case: test_call_hierarchy_outgoing_in_different_files. Preserve the imported canonical
// definition and its foo scope; the import itself is not a calls edge.
#[tokio::test]
async fn rust_cross_file() {
    let foo_callee = description("foo::callee", "foo/mod.rs", 1, 1);
    let caller = description("caller", "lib.rs", 4, 6);
    check_case(Case {
        name: "rust_cross_file",
        files: vec![
            SourceFile {
                path: "lib.rs",
                source: "mod foo;\nuse foo::callee;\n\nfn caller() {\n    callee();\n}\n\n",
            },
            SourceFile {
                path: "foo/mod.rs",
                source: "pub fn callee() {}\n",
            },
        ],
        queries: vec![
            Query {
                direction: "in",
                symbol: "callee",
                expected: vec![relationships(&foo_callee, &[(&caller, 5, 4)])],
            },
            Query {
                direction: "out",
                symbol: "caller",
                expected: vec![relationships(&caller, &[(&foo_callee, 5, 4)])],
            },
            Query {
                direction: "in",
                symbol: "foo::callee",
                expected: vec![relationships(&foo_callee, &[(&caller, 5, 4)])],
            },
        ],
    })
    .await;
}

// https://github.com/microsoft/pyright/blob/386cfa1161b63f048a9ea663d84189e69ced33b1/packages/pyright-internal/src/tests/fourslash/showcallhierarchy.outgoingCalls.aliasedFunction2.fourslash.ts
// Upstream case: outgoingCalls.aliasedFunction2. Upstream returns alias/display names and groups
// repeated calls. zvec-grep uses the canonical declare.py::func definition and preserves each
// site. Incoming queries below are inverse checks of these upstream outgoing relations. These
// queries do not request outgoing calls from func.
#[tokio::test]
async fn python_import_alias() {
    let call_by_alias = description("callByAlias", "consume.py", 4, 5);
    let func = description("func", "declare.py", 1, 2);
    let call_by_name = description("callByName", "consume.py", 7, 8);
    let call_by_both1 = description("callByBoth1", "consume.py", 10, 12);
    let call_by_both2 = description("callByBoth2", "consume.py", 14, 16);
    check_case(Case {
        name: "python_import_alias",
        files: vec![
            SourceFile {
                path: "declare.py",
                source: "def func():\n    func2()\n\ndef func2():\n    print(1)\n",
            },
            SourceFile {
                path: "consume.py",
                source: "from declare import func as foobar\nfrom declare import func\n\ndef callByAlias():\n    foobar()\n\ndef callByName():\n    func()\n\ndef callByBoth1():\n    func()\n    foobar()\n\ndef callByBoth2():\n    foobar()\n    func()\n",
            },
        ],
        queries: vec![
            Query {
                direction: "out",
                symbol: "callByAlias",
                expected: vec![
                    relationships(&call_by_alias, &[(&func, 5, 4)]),
                ],
            },
            Query {
                direction: "out",
                symbol: "callByName",
                expected: vec![
                    relationships(&call_by_name, &[(&func, 8, 4)]),
                ],
            },
            Query {
                direction: "out",
                symbol: "callByBoth1",
                expected: vec![
                    relationships(&call_by_both1, &[(&func, 11, 4), (&func, 12, 4)]),
                ],
            },
            Query {
                direction: "out",
                symbol: "callByBoth2",
                expected: vec![
                    relationships(&call_by_both2, &[(&func, 15, 4), (&func, 16, 4)]),
                ],
            },
            Query {
                direction: "in",
                symbol: "func",
                expected: vec![
                    relationships(&func, &[(&call_by_alias, 5, 4), (&call_by_name, 8, 4), (&call_by_both1, 11, 4), (&call_by_both1, 12, 4), (&call_by_both2, 15, 4), (&call_by_both2, 16, 4)]),
                ],
            },
        ],
    }).await;
}

// https://github.com/golang/tools/blob/31c58979aa257a4ccd3da5b6102a5d77cfc8d41b/gopls/internal/test/marker/testdata/callhierarchy/issue64451.txt
// Upstream case: issue64451. Strip marker comments, preserving source lines. gopls attributes
// calls inside anonymous functions to the enclosing named function or global variable. Builtin
// print has no outgoing item. The global underscore is a value entity.
#[tokio::test]
async fn go_enclosing_callers() {
    let baz = description("baz", "a/a.go", 11, 13);
    let bar = description("bar", "a/a.go", 7, 9);
    let global = description("_", "a/a.go", 19, 22);
    let init = description("init", "a/a.go", 24, 26);
    let bluh = description("bluh", "a/a.go", 15, 17);
    let foo = description("Foo", "a/a.go", 3, 5);
    check_case(Case {
        name: "go_enclosing_callers",
        files: vec![
            SourceFile {
                path: "a/a.go",
                source: "package a\n\nfunc Foo() {\n\tbar()\n}\n\nfunc bar() {\n\tgo func() { baz() }()\n}\n\nfunc baz() {\n\tbluh()\n}\n\nfunc bluh() {\n\tprint()\n}\n\nvar _ = func() int {\n\tbaz()\n\treturn 0\n}()\n\nfunc init() {\n\tbaz()\n}\n\n\n\n\n\n\n\n\n\n\n\n\n",
            },
        ],
        queries: vec![
            Query {
                direction: "in",
                symbol: "baz",
                expected: vec![
                    relationships(&baz, &[(&bar, 8, 13), (&global, 20, 1), (&init, 25, 1)]),
                ],
            },
            Query {
                direction: "out",
                symbol: "bar",
                expected: vec![
                    relationships(&bar, &[(&baz, 8, 13)]),
                ],
            },
            Query {
                direction: "out",
                symbol: "init",
                expected: vec![
                    relationships(&init, &[(&baz, 25, 1)]),
                ],
            },
            Query {
                direction: "in",
                symbol: "bluh",
                expected: vec![
                    relationships(&bluh, &[(&baz, 12, 1)]),
                ],
            },
            Query {
                direction: "out",
                symbol: "bluh",
                expected: vec![
                    relationships(&bluh, &[]),
                ],
            },
            Query {
                direction: "in",
                symbol: "Foo",
                expected: vec![
                    relationships(&foo, &[]),
                ],
            },
        ],
    }).await;
}

// https://github.com/eclipse-cdt/cdt/blob/4c37839cfbe3dde7bdfa398d9f703644052f5429/core/org.eclipse.cdt.ui.tests/ui/org/eclipse/cdt/ui/tests/callhierarchy/BasicCallHierarchyTest.java
// Upstream case: testStaticFunctionsC. CDT IDE supplement. Copy the two comment-embedded C
// snippets without their comment prefixes. Assert distinct same-named static functions, global
// calls and recursion. Outgoing checks are inverses of the upstream caller tree.
#[tokio::test]
async fn c_file_local_names() {
    let sf = description("sf", "staticFunc1.c", 2, 5);
    let gf = description("gf", "staticFunc1.c", 6, 9);
    let sf2 = description("sf", "staticFunc2.c", 2, 5);
    check_case(Case {
        name: "c_file_local_names",
        files: vec![
            SourceFile {
                path: "staticFunc1.c",
                source: "void gf();\nstatic void sf() {\n    gf();\n    sf();\n}\nvoid gf() {\n    gf();\n    sf();\n}\n",
            },
            SourceFile {
                path: "staticFunc2.c",
                source: "void gf();\nstatic void sf() {\n    gf();\n    sf();\n}\n",
            },
        ],
        queries: vec![
            Query {
                direction: "in",
                symbol: "sf",
                expected: vec![
                    relationships(&sf, &[(&sf, 4, 4), (&gf, 8, 4)]),
                    relationships(&sf2, &[(&sf2, 4, 4)]),
                ],
            },
            Query {
                direction: "out",
                symbol: "sf",
                expected: vec![
                    relationships(&sf, &[(&gf, 3, 4), (&sf, 4, 4)]),
                    relationships(&sf2, &[(&gf, 3, 4), (&sf2, 4, 4)]),
                ],
            },
            Query {
                direction: "in",
                symbol: "gf",
                expected: vec![
                    relationships(&gf, &[(&sf, 3, 4), (&gf, 7, 4), (&sf2, 3, 4)]),
                ],
            },
            Query {
                direction: "out",
                symbol: "gf",
                expected: vec![
                    relationships(&gf, &[(&gf, 7, 4), (&sf, 8, 4)]),
                ],
            },
        ],
    }).await;
}

// https://github.com/typescript-language-server/typescript-language-server/blob/d11657d1b6996158a64c680516fe2c31a14d9803/src/features/call-hierarchy.test.ts
// Upstream case: outgoing calls.
// https://github.com/typescript-language-server/typescript-language-server/blob/d11657d1b6996158a64c680516fe2c31a14d9803/src/features/call-hierarchy.test.ts
// Upstream case: incoming calls. Use original two.ts/three.ts. Query the outgoing subtree rooted
// at callThreeTwice: repeated method and implicit constructor calls, then tada -> print. The
// external console.log target has no indexed definition, and main is not among these source files.
// Adapt scopes to canonical scope::name and expand grouped callsites.
#[tokio::test]
async fn typescript_methods_and_constructors() {
    let two_call_three_twice = description("Two::callThreeTwice", "two.ts", 4, 7);
    let three = description("Three", "three.ts", 2, 6);
    let three_tada = description("Three::tada", "three.ts", 3, 5);
    let print = description("print", "three.ts", 7, 9);
    check_case(Case {
        name: "typescript_methods_and_constructors",
        files: vec![
            SourceFile {
                path: "two.ts",
                source: "// comment line\nimport { Three } from './three.js';\nexport class Two {\n    callThreeTwice() {\n        new Three().tada();\n        new Three().tada();\n    }\n}\n",
            },
            SourceFile {
                path: "three.ts",
                source: "// comment line\nexport class Three {\n    tada() {\n        print('🎉');\n    }\n}\nexport function print(s: string) {\n    console.log(s);\n}\n",
            },
        ],
        queries: vec![
            Query {
                direction: "out",
                symbol: "Two::callThreeTwice",
                expected: vec![
                    relationships(&two_call_three_twice, &[(&three, 5, 12), (&three_tada, 5, 20), (&three, 6, 12), (&three_tada, 6, 20)]),
                ],
            },
            Query {
                direction: "in",
                symbol: "Three::tada",
                expected: vec![
                    relationships(&three_tada, &[(&two_call_three_twice, 5, 20), (&two_call_three_twice, 6, 20)]),
                ],
            },
            Query {
                direction: "in",
                symbol: "Three",
                expected: vec![
                    relationships(&three, &[(&two_call_three_twice, 5, 12), (&two_call_three_twice, 6, 12)]),
                ],
            },
            Query {
                direction: "out",
                symbol: "Three::tada",
                expected: vec![
                    relationships(&three_tada, &[(&print, 4, 8)]),
                ],
            },
        ],
    }).await;
}

// https://github.com/eclipse-jdtls/eclipse.jdt.ls/blob/dd5d8cfaef9d0688ba4c3f9754cd79d25277ca99/org.eclipse.jdt.ls.tests/src/org/eclipse/jdt/ls/core/internal/handlers/CallHierarchyHandlerTest.java
// https://github.com/eclipse-jdtls/eclipse.jdt.ls/blob/dd5d8cfaef9d0688ba4c3f9754cd79d25277ca99/org.eclipse.jdt.ls.tests/projects/eclipse/hello/src/org/sample/CallHierarchy.java
// JDT LS incomingCalls_src / outgoingCalls_src. Preserve the source sample. Query local calls
// among main, Base and Child constructors, foo, bar and method_1. External JDK targets have no
// indexed definitions; fields are not calls. The recursive1/recursive2 component is not queried.
// Upstream grouped constructor ranges become individual edges. Additional inverse queries check
// the selected source relationships, including inherited methods. Definition ranges come from the
// source, not JDT call-item selection ranges.
#[tokio::test]
async fn java_methods_and_constructors() {
    const FILE: &str = "org/sample/CallHierarchy.java";
    let main = description("CallHierarchy::main", FILE, 6, 10);
    let base = description("CallHierarchy.Base::Base", FILE, 19, 21);
    let foo = description("CallHierarchy.Base::foo", FILE, 23, 25);
    let bar = description("CallHierarchy.Base::bar", FILE, 27, 32);
    let method_one = description("CallHierarchy.Base::method_1", FILE, 34, 37);
    let child = description("CallHierarchy.Child::Child", FILE, 43, 50);
    check_case(Case {
        name: "java_methods_and_constructors",
        files: vec![
            SourceFile {
                path: FILE,
                source: "package org.sample;\n\npublic class CallHierarchy {\n\n  @Deprecated\n  public static void main(String[] args) {\n    new Base();\n    new Child().bar();\n    System.out.println(Base.STATIC_FIELD);\n  }\n\n  public static class Base {\n\n    static int STATIC_FIELD = 100;\n    protected int protectedField = 200;\n\n/*nothing*/\n\n    public Base() {\n/*should resolve to enclosing \"method/constructor/initializer\"*/\n    }\n\n    public void foo() {\n\n    }\n\n    public void bar() {\n      new Child();\n      new Child();\n      Thread.currentThread();\n      Thread.currentThread();\n    }\n\n    protected void method_1() {\n      foo();\n      bar();\n    }\n\n  }\n\n  public static class Child extends Base {\n\n    Child() {\n      super();\n      foo();\n      bar();\n      method_1();\n      protectedField = 300;\n      protectedField = 400;\n    }\n\n    protected void method_2() {\n      method_1();\n      method_1();\n      method_1();\n    }\n\n  }\n\n  public void recursive1() {\n    recursive2();\n  }\n\n  public void recursive2() {\n    recursive1();\n  }\n}\n",
            },
        ],
        queries: vec![
            Query {
                direction: "in",
                symbol: "CallHierarchy.Base::bar",
                expected: vec![relationships(&bar, &[(&main, 8, 16), (&method_one, 36, 6), (&child, 46, 6)])],
            },
            Query {
                direction: "out",
                symbol: "CallHierarchy.Base::method_1",
                expected: vec![relationships(&method_one, &[(&foo, 35, 6), (&bar, 36, 6)])],
            },
            Query {
                direction: "out",
                symbol: "CallHierarchy.Base::bar",
                expected: vec![relationships(&bar, &[(&child, 28, 10), (&child, 29, 10)])],
            },
            Query {
                direction: "in",
                symbol: "CallHierarchy.Child::Child",
                expected: vec![relationships(&child, &[(&main, 8, 8), (&bar, 28, 10), (&bar, 29, 10)])],
            },
            Query {
                direction: "out",
                symbol: "CallHierarchy.Child::Child",
                expected: vec![relationships(&child, &[(&base, 44, 6), (&foo, 45, 6), (&bar, 46, 6), (&method_one, 47, 6)])],
            },
            Query {
                direction: "in",
                symbol: "CallHierarchy.Base::foo",
                expected: vec![relationships(&foo, &[(&method_one, 35, 6), (&child, 45, 6)])],
            },
        ],
    }).await;
}

// https://github.com/eclipse-jdtls/eclipse.jdt.ls/blob/dd5d8cfaef9d0688ba4c3f9754cd79d25277ca99/org.eclipse.jdt.ls.tests/src/org/eclipse/jdt/ls/core/internal/handlers/CallHierarchyHandlerTest.java
// https://github.com/eclipse-jdtls/eclipse.jdt.ls/blob/dd5d8cfaef9d0688ba4c3f9754cd79d25277ca99/org.eclipse.jdt.ls.tests/projects/eclipse/hello/src/org/sample/Call.java
// https://github.com/eclipse-jdtls/eclipse.jdt.ls/blob/dd5d8cfaef9d0688ba4c3f9754cd79d25277ca99/org.eclipse.jdt.ls.tests/projects/eclipse/hello/src/org/sample/Foo.java
// JDT LS testSelectionRange. Retain the two Call.main -> Foo.someMethod sites from the upstream
// caller result. JDK targets have no indexed definitions. Outgoing calls from main are not
// asserted here because the sample also constructs Foo. zvec-grep groups both sites under the
// canonical Call.main definition, while the upstream result has separate items at the two sites.
// Both qualified and unqualified symbol queries must find the same method.
#[tokio::test]
async fn java_cross_file_repeated_calls() {
    let entry = description("Call::main", "org/sample/Call.java", 4, 12);
    let method = description("Foo::someMethod", "org/sample/Foo.java", 9, 9);
    check_case(Case {
        name: "java_cross_file_repeated_calls",
        files: vec![
            SourceFile {
                path: "org/sample/Call.java",
                source: "package org.sample;\n\npublic class Call {\n    public static void main(String[] args) {\n        System.out.println(\"skip\");\n        System.out.println(\"skip\");\n        System.out.println(\"skip\");\n        new Foo().someMethod();\n        System.out.println(\"skip\");\n        System.out.println(\"skip\");\n        new Foo().someMethod();\n    }\n}\n",
            },
            SourceFile {
                path: "org/sample/Foo.java",
                source: "package org.sample;\n\npublic class Foo {\n\n\tpublic static void main(String[] args) {\n\t\tSystem.out.print(\"Hello world!\");\n\t}\n\t\n\tpublic void someMethod() {}\n}\n",
            },
        ],
        queries: vec![
            Query {
                direction: "in",
                symbol: "Foo::someMethod",
                expected: vec![relationships(&method, &[(&entry, 8, 18), (&entry, 11, 18)])],
            },
            Query {
                direction: "in",
                symbol: "someMethod",
                expected: vec![relationships(&method, &[(&entry, 8, 18), (&entry, 11, 18)])],
            },
        ],
    }).await;
}

// https://github.com/llvm/llvm-project/blob/fb2a5266d9afbbd1ac2f41a75bcda1b27eb51097/clang-tools-extra/clangd/unittests/CallHierarchyTests.cpp
// clangd IncomingQualified. Remove annotation markers, retaining source lines and indentation.
// Represent the out-of-line method definition once, with canonical ns::Waldo scope. Outgoing
// checks are inverses of the upstream incoming expectations; the declaration must not produce a
// duplicate method result.
#[tokio::test]
async fn cpp_qualified_method() {
    let method = description("ns::Waldo::find", "main.cc", 6, 6);
    let first = description("ns::caller1", "main.cc", 7, 9);
    let second = description("ns::caller2", "main.cc", 10, 12);
    check_case(Case {
        name: "cpp_qualified_method",
        files: vec![
            SourceFile {
                path: "main.cc",
                source: "\n    namespace ns {\n    struct Waldo {\n      void find();\n    };\n    void Waldo::find() {}\n    void caller1(Waldo &W) {\n      W.find();\n    }\n    void caller2(Waldo &W) {\n      W.find();\n    }\n    }\n  ",
            },
        ],
        queries: vec![
            Query {
                direction: "in",
                symbol: "ns::Waldo::find",
                expected: vec![relationships(&method, &[(&first, 8, 8), (&second, 11, 8)])],
            },
            Query {
                direction: "out",
                symbol: "ns::caller1",
                expected: vec![relationships(&first, &[(&method, 8, 8)])],
            },
            Query {
                direction: "out",
                symbol: "ns::caller2",
                expected: vec![relationships(&second, &[(&method, 11, 8)])],
            },
        ],
    }).await;
}

// https://github.com/llvm/llvm-project/blob/fb2a5266d9afbbd1ac2f41a75bcda1b27eb51097/clang-tools-extra/clangd/unittests/CallHierarchyTests.cpp
// clangd MultiFileCpp, definition-site incoming and outgoing expectations. Remove annotation
// markers and preserve source coordinates. Query canonical implementation definitions. Header
// declarations must not duplicate results; cursor-based prepare behavior is outside the symbol-
// name query contract. Qualified calls retain separate sites, and leaf/root queries return empty
// edges.
#[tokio::test]
async fn cpp_cross_file_call_chain() {
    let target = description("callee", "callee.cc", 3, 3);
    let first = description("nsa::caller1", "caller1.cc", 5, 7);
    let second = description("nsb::caller2", "caller2.cc", 5, 8);
    let third = description("nsa::caller3", "caller3.cc", 5, 8);
    check_case(Case {
        name: "cpp_cross_file_call_chain",
        files: vec![
            SourceFile { path: "callee.hh", source: "\n    void callee(int);\n  " },
            SourceFile { path: "caller1.hh", source: "\n    namespace nsa {\n      void caller1();\n    }\n  " },
            SourceFile { path: "caller2.hh", source: "\n    namespace nsb {\n      void caller2();\n    }\n  " },
            SourceFile { path: "caller3.hh", source: "\n    namespace nsa {\n      void caller3();\n    }\n  " },

            SourceFile {
                path: "callee.cc",
                source: "\n    #include \"callee.hh\"\n    void callee(int) {}\n  ",
            },
            SourceFile {
                path: "caller1.cc",
                source: "\n    #include \"callee.hh\"\n    #include \"caller1.hh\"\n    namespace nsa {\n      void caller1() {\n        callee(42);\n      }\n    }\n  ",
            },
            SourceFile {
                path: "caller2.cc",
                source: "\n    #include \"caller1.hh\"\n    #include \"caller2.hh\"\n    namespace nsb {\n      void caller2() {\n        nsa::caller1();\n        nsa::caller1();\n      }\n    }\n  ",
            },
            SourceFile {
                path: "caller3.cc",
                source: "\n    #include \"caller1.hh\"\n    #include \"caller2.hh\"\n    namespace nsa {\n      void caller3() {\n        caller1();\n        nsb::caller2();\n      }\n    }\n  ",
            },
        ],
        queries: vec![
            Query {
                direction: "in",
                symbol: "callee",
                expected: vec![relationships(&target, &[(&first, 6, 8)])],
            },
            Query {
                direction: "in",
                symbol: "nsa::caller1",
                expected: vec![relationships(&first, &[(&second, 6, 13), (&second, 7, 13), (&third, 6, 8)])],
            },
            Query {
                direction: "in",
                symbol: "nsb::caller2",
                expected: vec![relationships(&second, &[(&third, 7, 13)])],
            },
            Query {
                direction: "in",
                symbol: "nsa::caller3",
                expected: vec![relationships(&third, &[])],
            },
            Query {
                direction: "out",
                symbol: "nsa::caller3",
                expected: vec![relationships(&third, &[(&first, 6, 8), (&second, 7, 13)])],
            },
            Query {
                direction: "out",
                symbol: "nsb::caller2",
                expected: vec![relationships(&second, &[(&first, 6, 13), (&first, 7, 13)])],
            },
            Query {
                direction: "out",
                symbol: "nsa::caller1",
                expected: vec![relationships(&first, &[(&target, 6, 8)])],
            },
            Query {
                direction: "out",
                symbol: "callee",
                expected: vec![relationships(&target, &[])],
            },
        ],
    }).await;
}

// https://github.com/llvm/llvm-project/blob/fb2a5266d9afbbd1ac2f41a75bcda1b27eb51097/clang-tools-extra/clangd/unittests/CallHierarchyTests.cpp
// clangd IncomingIncludeOverrides. Adopt its incoming-call semantics: a call through
// Interface::Func is included among Implementation::Func callers. This explicitly requires
// override-aware resolution; lexical matching alone is insufficient. The outgoing implementation-
// to-callee check is the inverse of the first upstream incoming level.
#[tokio::test]
async fn cpp_virtual_override_callers() {
    let target = description("callee", "virtual.cc", 2, 2);
    let implementation = description("Implementation::Func", "virtual.cc", 7, 9);
    let entry = description("Test", "virtual.cc", 11, 13);
    check_case(Case {
        name: "cpp_virtual_override_callers",
        files: vec![
            SourceFile { path: "virtual.cc", source: "\n    void callee() {}\n    struct Interface {\n      virtual void Func() = 0;\n    };\n    struct Implementation : public Interface {\n      void Func() override {\n          callee();\n      }\n    };\n    void Test(Interface& cls){\n      cls.Func();\n    }\n  " },
        ],
        queries: vec![
            Query { direction: "in", symbol: "Implementation::Func", expected: vec![
                relationships(&implementation, &[(&entry, 12, 10)]),
            ] },
            Query { direction: "in", symbol: "callee", expected: vec![
                relationships(&target, &[(&implementation, 8, 10)]),
            ] },
            Query { direction: "out", symbol: "Implementation::Func", expected: vec![
                relationships(&implementation, &[(&target, 8, 10)]),
            ] },
        ],
    }).await;
}

// https://github.com/llvm/llvm-project/blob/fb2a5266d9afbbd1ac2f41a75bcda1b27eb51097/clang-tools-extra/clangd/unittests/CallHierarchyTests.cpp
// clangd CallInLocalVarDecl. A local variable initializer belongs to its enclosing function; a
// namespace-level initializer belongs to the global variable itself. Do not emit localVar as a
// separate caller. Outgoing checks invert these upstream incoming expectations.
#[tokio::test]
async fn cpp_initializer_caller_ownership() {
    let target = description("callee", "initializers.cc", 2, 2);
    let direct = description("caller1", "initializers.cc", 3, 5);
    let local = description("caller2", "initializers.cc", 6, 8);
    let global = description("caller3", "initializers.cc", 9, 9);
    check_case(Case {
        name: "cpp_initializer_caller_ownership",
        files: vec![
            SourceFile { path: "initializers.cc", source: "\n    int callee();\n    void caller1() {\n      callee();\n    }\n    void caller2() {\n      int localVar = callee();\n    }\n    int caller3 = callee();\n  " },
        ],
        queries: vec![
            Query { direction: "in", symbol: "callee", expected: vec![
                relationships(&target, &[(&direct, 4, 6), (&local, 7, 21), (&global, 9, 18)]),
            ] },
            Query { direction: "out", symbol: "caller2", expected: vec![
                relationships(&local, &[(&target, 7, 21)]),
            ] },
            Query { direction: "out", symbol: "caller3", expected: vec![
                relationships(&global, &[(&target, 9, 18)]),
            ] },
        ],
    }).await;
}

// https://github.com/microsoft/TypeScript/blob/fed0bf24149fb1ed36039212648bafdafc1ea10e/tsc/internal/fourslash/tests/callHierarchyFunctionAmbiguity1_test.go
// https://github.com/microsoft/TypeScript/blob/fed0bf24149fb1ed36039212648bafdafc1ea10e/tsc/testdata/baselines/reference/fourslash/callHierarchy/callHierarchyFunctionAmbiguity.1.callHierarchy.txt
// https://github.com/microsoft/TypeScript/blob/fed0bf24149fb1ed36039212648bafdafc1ea10e/tsc/testdata/baselines/reference/fourslash/callHierarchy/callHierarchyFunctionAmbiguity.5.callHierarchy.txt
// TypeScript FunctionAmbiguity1-5 share these source files and differ only in cursor selection.
// Adopt the baseline canonical targets: a.d.ts::foo and the first b.d.ts::foo declaration. The
// boolean overload belongs to the latter group. One callsite has two possible targets; retain
// both, without duplicating b.d.ts by overload. This is overload ambiguity, not unrelated same-
// name scopes.
#[tokio::test]
async fn typescript_ambiguous_overload_declarations() {
    let number = description("foo", "a.d.ts", 1, 1);
    let string = description("foo", "b.d.ts", 1, 1);
    let entry = description("bar", "main.ts", 1, 3);
    check_case(Case {
        name: "typescript_ambiguous_overload_declarations",
        files: vec![
            SourceFile { path: "a.d.ts", source: "declare function foo(x?: number): void;\n" },
            SourceFile { path: "b.d.ts", source: "declare function foo(x?: string): void;\ndeclare function foo(x?: boolean): void;\n" },
            SourceFile { path: "main.ts", source: "function bar() {\n    foo();\n}\n" },
        ],
        queries: vec![
            Query { direction: "in", symbol: "foo", expected: vec![
                relationships(&number, &[(&entry, 2, 4)]),
                relationships(&string, &[(&entry, 2, 4)]),
            ] },
            Query { direction: "out", symbol: "bar", expected: vec![
                relationships(&entry, &[(&number, 2, 4), (&string, 2, 4)]),
            ] },
        ],
    }).await;
}

// Additional zvec-grep regression, not copied from an upstream case. Two independent namespaces
// each define work and caller. Unqualified lookup must return separate definitions, and qualified
// lookup must never attach calls from the other scope.
#[tokio::test]
async fn typescript_same_name_scopes() {
    let left_target = description("Left::work", "scopes.ts", 2, 2);
    let left_entry = description("Left::caller", "scopes.ts", 3, 5);
    let right_target = description("Right::work", "scopes.ts", 8, 8);
    let right_entry = description("Right::caller", "scopes.ts", 9, 11);
    check_case(Case {
        name: "typescript_same_name_scopes",
        files: vec![
            SourceFile { path: "scopes.ts", source: "namespace Left {\n    export function work() {}\n    export function caller() {\n        work();\n    }\n}\nnamespace Right {\n    export function work() {}\n    export function caller() {\n        work();\n    }\n}\n" },
        ],
        queries: vec![
            Query { direction: "out", symbol: "caller", expected: vec![
                relationships(&left_entry, &[(&left_target, 4, 8)]),
                relationships(&right_entry, &[(&right_target, 10, 8)]),
            ] },
            Query { direction: "in", symbol: "Right::work", expected: vec![
                relationships(&right_target, &[(&right_entry, 10, 8)]),
            ] },
            Query { direction: "in", symbol: "work", expected: vec![
                relationships(&left_target, &[(&left_entry, 4, 8)]),
                relationships(&right_target, &[(&right_entry, 10, 8)]),
            ] },
            Query { direction: "in", symbol: "Left::work", expected: vec![
                relationships(&left_target, &[(&left_entry, 4, 8)]),
            ] },
            Query { direction: "out", symbol: "Left::caller", expected: vec![
                relationships(&left_entry, &[(&left_target, 4, 8)]),
            ] },
            Query { direction: "out", symbol: "Right::caller", expected: vec![
                relationships(&right_entry, &[(&right_target, 10, 8)]),
            ] },
        ],
    }).await;
}

// https://github.com/microsoft/TypeScript/blob/fed0bf24149fb1ed36039212648bafdafc1ea10e/tsc/internal/fourslash/tests/callHierarchyConstNamedFunctionExpression_test.go
// https://github.com/microsoft/TypeScript/blob/fed0bf24149fb1ed36039212648bafdafc1ea10e/tsc/testdata/baselines/reference/fourslash/callHierarchy/callHierarchyConstNamedFunctionExpression.callHierarchy.txt
// TypeScript ConstNamedFunctionExpression. The anonymous function is named by its variable binding
// bar. Calls within it belong to bar, not a file entity or foo; this is a relationship assertion,
// not a no-crash-only regression. Additional inverse queries preserve the upstream edges.
#[tokio::test]
async fn typescript_anonymous_function_binding() {
    let entry = description("foo", "anonymous.ts", 1, 3);
    let binding = description("bar", "anonymous.ts", 5, 7);
    let target = description("baz", "anonymous.ts", 9, 10);
    check_case(Case {
        name: "typescript_anonymous_function_binding",
        files: vec![
            SourceFile { path: "anonymous.ts", source: "function foo() {\n    bar();\n}\n\nconst bar = function () {\n    baz();\n}\n\nfunction baz() {\n}\n" },
        ],
        queries: vec![
            Query { direction: "in", symbol: "bar", expected: vec![
                relationships(&binding, &[(&entry, 2, 4)]),
            ] },
            Query { direction: "out", symbol: "bar", expected: vec![
                relationships(&binding, &[(&target, 6, 4)]),
            ] },
            Query { direction: "in", symbol: "baz", expected: vec![
                relationships(&target, &[(&binding, 6, 4)]),
            ] },
            Query { direction: "out", symbol: "foo", expected: vec![
                relationships(&entry, &[(&binding, 2, 4)]),
            ] },
        ],
    }).await;
}

// https://github.com/microsoft/TypeScript/blob/fed0bf24149fb1ed36039212648bafdafc1ea10e/tsc/internal/fourslash/tests/callHierarchyClassPropertyArrowFunction_test.go
// https://github.com/microsoft/TypeScript/blob/fed0bf24149fb1ed36039212648bafdafc1ea10e/tsc/testdata/baselines/reference/fourslash/callHierarchy/callHierarchyClassPropertyArrowFunction.callHierarchy.txt
// TypeScript ClassPropertyArrowFunction. Attribute this.callee() to the caller arrow-function
// property, and resolve this against C. Canonical scopes use C::name; definition line spans match
// the upstream arrow functions. Outgoing is the inverse of the upstream incoming edge.
#[tokio::test]
async fn typescript_class_arrow_function() {
    let entry = description("C::caller", "arrows.ts", 2, 4);
    let target = description("C::callee", "arrows.ts", 6, 7);
    check_case(Case {
        name: "typescript_class_arrow_function",
        files: vec![
            SourceFile { path: "arrows.ts", source: "class C {\n    caller = () => {\n        this.callee();\n    }\n\n    callee = () => {\n    }\n}\n" },
        ],
        queries: vec![
            Query { direction: "in", symbol: "C::callee", expected: vec![
                relationships(&target, &[(&entry, 3, 13)]),
            ] },
            Query { direction: "out", symbol: "C::caller", expected: vec![
                relationships(&entry, &[(&target, 3, 13)]),
            ] },
            Query { direction: "out", symbol: "C::callee", expected: vec![
                relationships(&target, &[]),
            ] },
        ],
    }).await;
}

// https://github.com/eclipse-jdtls/eclipse.jdt.ls/blob/dd5d8cfaef9d0688ba4c3f9754cd79d25277ca99/org.eclipse.jdt.ls.tests/src/org/eclipse/jdt/ls/core/internal/handlers/CallHierarchyHandlerTest.java
// https://github.com/eclipse-jdtls/eclipse.jdt.ls/blob/dd5d8cfaef9d0688ba4c3f9754cd79d25277ca99/org.eclipse.jdt.ls.tests/projects/eclipse/hello/src/org/sample/CallHierarchyGH2771.java
// JDT LS incomingCalls_OnInterfaceMethod. The interface method name exists but has no callers. Its
// Opt<String> return type is not a calls edge from name. The outgoing empty assertion extends the
// upstream incoming expectation to guard against misclassifying type references.
#[tokio::test]
async fn java_interface_without_callers() {
    let method = description(
        "CallHierarchyGH2771::name",
        "org/sample/CallHierarchyGH2771.java",
        4,
        4,
    );
    check_case(Case {
        name: "java_interface_without_callers",
        files: vec![
            SourceFile { path: "org/sample/CallHierarchyGH2771.java", source: "package org.sample;\n\npublic interface CallHierarchyGH2771 {\n    Opt<String> name();\n\n    public static class Opt<T> {\n        public static <T> Opt<T> of(T t) {\n            return new Opt();\n        }\n    }\n}\n" },
        ],
        queries: vec![
            Query { direction: "in", symbol: "CallHierarchyGH2771::name", expected: vec![
                relationships(&method, &[]),
            ] },
            Query { direction: "out", symbol: "CallHierarchyGH2771::name", expected: vec![
                relationships(&method, &[]),
            ] },
        ],
    }).await;
}

// zvec-grep-specific incremental regressions, not upstream LSP fixtures.
// Keep one engine and its read-session cache alive across updates. Only the
// explicitly changed file is submitted to index; callers must be re-resolved
// when a target disappears or changes identity without rewriting caller source.
struct IncrementalWorkspace {
    directory: tempfile::TempDir,
    glob: &'static str,
    _embeddings: EmbeddingServer,
    engine: ZvecGrep,
}

impl IncrementalWorkspace {
    async fn new() -> Self {
        Self::from_sources(
            &[
                SourceFile {
                    path: "caller.py",
                    source: "from targets import first, second\ndef caller():\n    first()\n",
                },
                SourceFile {
                    path: "targets.py",
                    source: "def first():\n    pass\n\ndef second():\n    pass\n",
                },
            ],
            "*.py",
        )
        .await
    }

    async fn from_sources(files: &[SourceFile], glob: &'static str) -> Self {
        let directory = tempfile::tempdir().expect("incremental workspace");
        let root = directory.path();
        for file in files {
            let path = root.join(file.path);
            fs::create_dir_all(path.parent().expect("source directory")).expect("source directory");
            fs::write(path, file.source).expect("source file");
        }
        let embeddings = EmbeddingServer::start().expect("embedding server");
        configure_remote_model(root, embeddings.address).expect("embedding configuration");
        let workspace = Self {
            directory,
            glob,
            _embeddings: embeddings,
            engine: ZvecGrep::new(),
        };
        let indexed = workspace.index(Vec::new()).await;
        assert_eq!(indexed.files_added, files.len());
        workspace
            .engine
            .enable_read_session_cache()
            .expect("read cache");
        workspace
    }

    async fn index(&self, changes: Vec<WorkspaceChange>) -> IndexResult {
        let mut options = index_options(self.directory.path());
        options.scan.globs = Some(vec![self.glob.into()]);
        options.changes = changes;
        let result = self
            .engine
            .index(options)
            .await
            .expect("index source changes");
        assert_eq!(result.files_failed, 0, "{result:?}");
        assert!(result.skipped.is_empty(), "{result:?}");
        result
    }

    async fn check(&self, stage: &str, queries: &[Query]) {
        check_queries(&self.engine, self.directory.path(), stage, queries).await;
    }

    async fn check_initial_calls(&self, stage: &str) {
        let entry = description("caller", "caller.py", 2, 3);
        let first = description("first", "targets.py", 1, 2);
        let second = description("second", "targets.py", 4, 5);
        self.check(
            stage,
            &[
                Query {
                    direction: "out",
                    symbol: "caller",
                    expected: vec![relationships(&entry, &[(&first, 3, 4)])],
                },
                Query {
                    direction: "in",
                    symbol: "first",
                    expected: vec![relationships(&first, &[(&entry, 3, 4)])],
                },
                Query {
                    direction: "in",
                    symbol: "second",
                    expected: vec![relationships(&second, &[])],
                },
            ],
        )
        .await;
    }
}

impl Drop for IncrementalWorkspace {
    fn drop(&mut self) {
        self.engine.close();
    }
}

#[tokio::test]
async fn incremental_call_target_change_removes_old_edge() {
    let workspace = IncrementalWorkspace::new().await;
    workspace.check_initial_calls("before call edit").await;
    fs::write(
        workspace.directory.path().join("caller.py"),
        "from targets import first, second\ndef caller():\n    second()\n",
    )
    .expect("retarget call");
    let indexed = workspace
        .index(vec![WorkspaceChange::Upsert("caller.py".into())])
        .await;
    assert_eq!(indexed.files_modified, 1);
    let entry = description("caller", "caller.py", 2, 3);
    let first = description("first", "targets.py", 1, 2);
    let second = description("second", "targets.py", 4, 5);
    workspace
        .check(
            "after call edit",
            &[
                Query {
                    direction: "out",
                    symbol: "caller",
                    expected: vec![relationships(&entry, &[(&second, 3, 4)])],
                },
                Query {
                    direction: "in",
                    symbol: "first",
                    expected: vec![relationships(&first, &[])],
                },
                Query {
                    direction: "in",
                    symbol: "second",
                    expected: vec![relationships(&second, &[(&entry, 3, 4)])],
                },
            ],
        )
        .await;
}

#[tokio::test]
async fn incremental_target_deletion_invalidates_incoming_edges() {
    let workspace = IncrementalWorkspace::new().await;
    workspace
        .check_initial_calls("before target deletion")
        .await;
    fs::remove_file(workspace.directory.path().join("targets.py")).expect("delete targets");
    let indexed = workspace
        .index(vec![WorkspaceChange::Delete("targets.py".into())])
        .await;
    assert_eq!(indexed.files_deleted, 1);
    let entry = description("caller", "caller.py", 2, 3);
    workspace
        .check(
            "deleted target must not leave a dangling resolved edge",
            &[Query {
                direction: "out",
                symbol: "caller",
                expected: vec![relationships(&entry, &[])],
            }],
        )
        .await;
}

#[tokio::test]
async fn incremental_target_recreation_resolves_unchanged_caller() {
    let workspace = IncrementalWorkspace::new().await;
    workspace
        .check_initial_calls("before target replacement")
        .await;
    let target_path = workspace.directory.path().join("targets.py");
    fs::remove_file(&target_path).expect("delete targets");
    let deleted = workspace
        .index(vec![WorkspaceChange::Delete("targets.py".into())])
        .await;
    assert_eq!(deleted.files_deleted, 1);
    let entry = description("caller", "caller.py", 2, 3);
    workspace
        .check(
            "between deletion and recreation",
            &[Query {
                direction: "out",
                symbol: "caller",
                expected: vec![relationships(&entry, &[])],
            }],
        )
        .await;
    // New content and definition position require a new canonical entity ID.
    fs::write(
        target_path,
        "\n\ndef first():\n    return 42\n\ndef second():\n    pass\n",
    )
    .expect("recreate target with changed identity");
    let recreated = workspace
        .index(vec![WorkspaceChange::Upsert("targets.py".into())])
        .await;
    assert_eq!(recreated.files_added, 1);
    assert_eq!(
        recreated.files_modified, 0,
        "caller source was not reindexed"
    );
    let first = description("first", "targets.py", 3, 4);
    workspace
        .check(
            "recreated target rebinds the unchanged caller",
            &[
                Query {
                    direction: "out",
                    symbol: "caller",
                    expected: vec![relationships(&entry, &[(&first, 3, 4)])],
                },
                Query {
                    direction: "in",
                    symbol: "first",
                    expected: vec![relationships(&first, &[(&entry, 3, 4)])],
                },
            ],
        )
        .await;
}

#[tokio::test]
async fn incremental_caller_deletion_removes_outgoing_edges() {
    let workspace = IncrementalWorkspace::new().await;
    workspace
        .check_initial_calls("before caller deletion")
        .await;
    fs::remove_file(workspace.directory.path().join("caller.py")).expect("delete caller");
    let indexed = workspace
        .index(vec![WorkspaceChange::Delete("caller.py".into())])
        .await;
    assert_eq!(indexed.files_deleted, 1);
    let first = description("first", "targets.py", 1, 2);
    let second = description("second", "targets.py", 4, 5);
    workspace
        .check(
            "after caller deletion",
            &[
                Query {
                    direction: "in",
                    symbol: "first",
                    expected: vec![relationships(&first, &[])],
                },
                Query {
                    direction: "in",
                    symbol: "second",
                    expected: vec![relationships(&second, &[])],
                },
            ],
        )
        .await;
}

#[tokio::test]
async fn repeated_index_does_not_accumulate_call_edges() {
    let workspace = IncrementalWorkspace::new().await;
    workspace.check_initial_calls("initial index").await;
    for revision in 1..=2 {
        // Change the file outside the function so its canonical entity and
        // callsite stay identical while indexing must replace its graph.
        fs::write(
            workspace.directory.path().join("caller.py"),
            format!("from targets import first, second\ndef caller():\n    first()\n# revision {revision}\n"),
        )
        .expect("change file while preserving callsite");
        let updated = workspace
            .index(vec![WorkspaceChange::Upsert("caller.py".into())])
            .await;
        assert_eq!(updated.files_modified, 1);
        workspace
            .check_initial_calls("file replacement keeps one callsite")
            .await;
        let unchanged = workspace.index(Vec::new()).await;
        assert_eq!(unchanged.files_unchanged, 2);
        assert_eq!(
            unchanged.files_added + unchanged.files_modified + unchanged.files_deleted,
            0
        );
        workspace
            .check_initial_calls("unchanged reindex keeps one callsite")
            .await;
    }
}

// https://github.com/PHPantom-dev/phpantom_lsp/blob/1756b1f920c1290d4c4fdd4d2c902fad53a75cd3/tests/integration/call_hierarchy.rs
// Port the PHPantom recursive-function scenario to Rust, which has a configured parser. Preserve
// the self-call expectation in both directions; this is a translated scenario, not an original
// Rust upstream fixture.
#[tokio::test]
async fn rust_self_recursion() {
    let function = description("countdown", "recursive.rs", 1, 3);
    check_case(Case {
        name: "rust_self_recursion",
        files: vec![SourceFile {
            path: "recursive.rs",
            source: "fn countdown(n: i32) {\n    if n > 0 { countdown(n - 1); }\n}\n",
        }],
        queries: vec![
            Query {
                direction: "in",
                symbol: "countdown",
                expected: vec![relationships(&function, &[(&function, 2, 15)])],
            },
            Query {
                direction: "out",
                symbol: "countdown",
                expected: vec![relationships(&function, &[(&function, 2, 15)])],
            },
        ],
    })
    .await;
}

// https://github.com/rust-lang/rust-analyzer/blob/3131751eaf1c3b5da6e618acdc2148ad7db65bc7/crates/ide/src/call_hierarchy.rs
// Adapt test_call_hierarchy_in_macros_incoming: retain the generated definition and call macro,
// remove cursor markers, and correct fn $ident {} to fn $ident() {} so the fixture is valid Rust.
// Anchor the generated definition to define!(callee), and the callsite to the callee argument of
// call!. The inverse outgoing expectation is a zvec-grep requirement; upstream outgoing is an
// acknowledged FIXME with an empty result, not the oracle.
#[tokio::test]
async fn rust_macro_generated_definition() {
    let target = description("callee", "macros.rs", 11, 11);
    let entry = description("caller", "macros.rs", 12, 14);
    check_case(Case {
        name: "rust_macro_generated_definition",
        files: vec![
            SourceFile { path: "macros.rs", source: "macro_rules! define {\n    ($ident:ident) => {\n        fn $ident() {}\n    }\n}\nmacro_rules! call {\n    ($ident:ident) => {\n        $ident()\n    }\n}\ndefine!(callee);\nfn caller() {\n    call!(callee);\n}\n" },
        ],
        queries: vec![
            Query { direction: "in", symbol: "callee", expected: vec![
                relationships(&target, &[(&entry, 13, 10)]),
            ] },
            Query { direction: "out", symbol: "caller", expected: vec![
                relationships(&entry, &[(&target, 13, 10)]),
            ] },
        ],
    }).await;
}

// https://github.com/rust-lang/rust-analyzer/blob/3131751eaf1c3b5da6e618acdc2148ad7db65bc7/crates/ide/src/call_hierarchy.rs
// Adapt test_call_hierarchy_in_macros_incoming_different_files, first subcase. Fix generated-
// function syntax as in the local macro test. Definition and callsite are attributed to the
// invocation file, not the macro definition file. The outgoing assertion is an inverse regression,
// not the upstream FIXME expectation.
#[tokio::test]
async fn rust_cross_file_macro_call() {
    let target = description("callee", "lib.rs", 3, 3);
    let entry = description("caller", "lib.rs", 4, 6);
    check_case(Case {
        name: "rust_cross_file_macro_call",
        files: vec![
            SourceFile { path: "lib.rs", source: "#[macro_use]\nmod definitions;\ndefine!(callee);\nfn caller() {\n    call!(callee);\n}\n" },
            SourceFile { path: "definitions.rs", source: "macro_rules! define {\n    ($ident:ident) => {\n        fn $ident() {}\n    }\n}\nmacro_rules! call {\n    ($ident:ident) => {\n        $ident()\n    }\n}\n" },
        ],
        queries: vec![
            Query { direction: "in", symbol: "callee", expected: vec![
                relationships(&target, &[(&entry, 5, 10)]),
            ] },
            Query { direction: "out", symbol: "caller", expected: vec![
                relationships(&entry, &[(&target, 5, 10)]),
            ] },
        ],
    }).await;
}

// https://github.com/ycm-core/ycmd/blob/a290328810cec343fc4df23ff86936cfa7630687/ycmd/tests/javascript/subcommands_test.py
// https://github.com/ycm-core/ycmd/blob/a290328810cec343fc4df23ff86936cfa7630687/ycmd/tests/javascript/testdata/test.js
// https://github.com/ycm-core/ycmd/blob/a290328810cec343fc4df23ff86936cfa7630687/ycmd/tests/javascript/testdata/file2.js
// https://github.com/ycm-core/ycmd/blob/a290328810cec343fc4df23ff86936cfa7630687/ycmd/tests/javascript/testdata/file3.js
// Adapt ycmd/tsserver test_Subcommands_GoToCallers, a JavaScript integration supplement rather
// than an LSP protocol test. Keep its three Bar.testMethod receiver shapes and simplify unrelated
// declarations. Wrap the original top-level callsites in named functions so this case tests
// symbol-name queries without inventing a file-symbol contract. Remap positions to these source
// snippets. Outgoing assertions include implicit construction via the Bar class entity, as in the
// existing TypeScript constructor case.
#[tokio::test]
async fn javascript_cross_file_method_calls() {
    let class = description("Bar", "test.js", 1, 3);
    let method = description("Bar::testMethod", "test.js", 2, 2);
    let local = description("localCaller", "test.js", 4, 7);
    let expression = description("expressionCaller", "file2.js", 1, 3);
    let remote = description("remoteCaller", "file3.js", 1, 4);
    check_case(Case {
        name: "javascript_cross_file_method_calls",
        files: vec![
            SourceFile { path: "test.js", source: "class Bar {\n  testMethod() {}\n}\nfunction localCaller() {\n  var bar = new Bar();\n  bar.testMethod();\n}\n" },
            SourceFile { path: "file2.js", source: "function expressionCaller() {\n  new Bar().testMethod();\n}\n" },
            SourceFile { path: "file3.js", source: "function remoteCaller() {\n  var bar = new Bar();\n  bar.testMethod();\n}\n" },
        ],
        queries: vec![
            Query { direction: "in", symbol: "Bar::testMethod", expected: vec![
                relationships(&method, &[(&local, 6, 6), (&expression, 2, 12), (&remote, 3, 6)]),
            ] },
            Query { direction: "out", symbol: "localCaller", expected: vec![
                relationships(&local, &[(&class, 5, 16), (&method, 6, 6)]),
            ] },
            Query { direction: "out", symbol: "expressionCaller", expected: vec![
                relationships(&expression, &[(&class, 2, 6), (&method, 2, 12)]),
            ] },
            Query { direction: "out", symbol: "remoteCaller", expected: vec![
                relationships(&remote, &[(&class, 2, 16), (&method, 3, 6)]),
            ] },
        ],
    }).await;
}

// https://github.com/microsoft/TypeScript/blob/fed0bf24149fb1ed36039212648bafdafc1ea10e/tsc/internal/fourslash/tests/callHierarchyClassStaticBlock_test.go
// https://github.com/microsoft/TypeScript/blob/fed0bf24149fb1ed36039212648bafdafc1ea10e/tsc/testdata/baselines/reference/fourslash/callHierarchy/callHierarchyClassStaticBlock.callHierarchy.txt
// https://github.com/microsoft/TypeScript/blob/fed0bf24149fb1ed36039212648bafdafc1ea10e/tsc/testdata/baselines/reference/fourslash/callHierarchy/callHierarchyClassStaticBlock2.callHierarchy.txt
// Run the TypeScript upstream static-block sample as .js: the sample contains only JavaScript
// syntax. This is a language-mode adaptation, not an independent JavaScript upstream test. Add the
// canonical C scope and name the initializer C::static {}. Calls inside nested foo/bar belong to
// those functions; only the direct foo() belongs to the static block. Preserve repeated baz sites.
#[tokio::test]
async fn javascript_static_block_call_ownership() {
    let block = description("C::static {}", "static.js", 2, 14);
    let first = description("C::foo", "static.js", 3, 5);
    let second = description("C::bar", "static.js", 7, 11);
    let target = description("baz", "static.js", 17, 18);
    let other = description("quxx", "static.js", 20, 21);
    check_case(Case {
        name: "javascript_static_block_call_ownership",
        files: vec![
            SourceFile { path: "static.js", source: "class C {\n    static {\n        function foo() {\n            bar();\n        }\n\n        function bar() {\n            baz();\n            quxx();\n            baz();\n        }\n\n        foo();\n    }\n}\n\nfunction baz() {\n}\n\nfunction quxx() {\n}\n" },
        ],
        queries: vec![
            Query { direction: "out", symbol: "C::static {}", expected: vec![
                relationships(&block, &[(&first, 13, 8)]),
            ] },
            Query { direction: "in", symbol: "C::foo", expected: vec![
                relationships(&first, &[(&block, 13, 8)]),
            ] },
            Query { direction: "in", symbol: "C::bar", expected: vec![
                relationships(&second, &[(&first, 4, 12)]),
            ] },
            Query { direction: "out", symbol: "C::bar", expected: vec![
                relationships(&second, &[(&target, 8, 12), (&other, 9, 12), (&target, 10, 12)]),
            ] },
        ],
    }).await;
}

// https://github.com/golang/tools/blob/31c58979aa257a4ccd3da5b6102a5d77cfc8d41b/gopls/internal/test/marker/testdata/callhierarchy/issue75230.txt
// gopls issue75230 excludes calls to builtin error.Error, which has no package definition.
// Preserve the source after removing marker comments: outgoing A is empty, not a fabricated
// workspace match or a crash.
#[tokio::test]
async fn go_builtin_method_without_indexed_target() {
    let function = description("A", "a/a.go", 3, 5);
    check_case(Case {
        name: "go_builtin_method_without_indexed_target",
        files: vec![SourceFile {
            path: "a/a.go",
            source: "package a\n\nfunc A(err error) string {\n\treturn err.Error()\n}\n",
        }],
        queries: vec![
            Query {
                direction: "out",
                symbol: "A",
                expected: vec![relationships(&function, &[])],
            },
            Query {
                direction: "in",
                symbol: "A",
                expected: vec![relationships(&function, &[])],
            },
        ],
    })
    .await;
}

// https://github.com/golang/tools/blob/31c58979aa257a4ccd3da5b6102a5d77cfc8d41b/gopls/internal/test/marker/testdata/callhierarchy/callhierarchy.txt
// Adapt the incoming.A -> callhierarchy.D -> outgoing.B subgraph of gopls callhierarchy. Remove
// unrelated declarations and D calls, remapping source coordinates. Retain package-qualified
// imports and use a go.mod to define the module root. Public symbol names remain A, D and B;
// packages are represented by their source paths in this API.
#[tokio::test]
async fn go_cross_package_call_chain() {
    let entry = description("A", "incoming/incoming.go", 5, 7);
    let middle = description("D", "hierarchy.go", 5, 7);
    let target = description("B", "outgoing/outgoing.go", 3, 3);
    check_case(Case {
        name: "go_cross_package_call_chain",
        files: vec![
            SourceFile { path: "go.mod", source: "module golang.org/lsptests/callhierarchy\ngo 1.17\n" },
            SourceFile { path: "incoming/incoming.go", source: "package incoming\n\nimport \"golang.org/lsptests/callhierarchy\"\n\nfunc A() {\n\tcallhierarchy.D()\n}\n" },
            SourceFile { path: "hierarchy.go", source: "package callhierarchy\n\nimport \"golang.org/lsptests/callhierarchy/outgoing\"\n\nfunc D() {\n\toutgoing.B()\n}\n" },
            SourceFile { path: "outgoing/outgoing.go", source: "package outgoing\n\nfunc B() {}\n" },
        ],
        queries: vec![
            Query { direction: "in", symbol: "D", expected: vec![
                relationships(&middle, &[(&entry, 6, 15)]),
            ] },
            Query { direction: "out", symbol: "D", expected: vec![
                relationships(&middle, &[(&target, 6, 10)]),
            ] },
            Query { direction: "in", symbol: "B", expected: vec![
                relationships(&target, &[(&middle, 6, 10)]),
            ] },
            Query { direction: "out", symbol: "A", expected: vec![
                relationships(&entry, &[(&middle, 6, 15)]),
            ] },
        ],
    }).await;
}

// https://github.com/microsoft/TypeScript/blob/fed0bf24149fb1ed36039212648bafdafc1ea10e/tsc/internal/fourslash/tests/callHierarchyAccessor_test.go
// https://github.com/microsoft/TypeScript/blob/fed0bf24149fb1ed36039212648bafdafc1ea10e/tsc/testdata/baselines/reference/fourslash/callHierarchy/callHierarchyAccessor.callHierarchy.txt
// TypeScript Accessor: reading new C().bar invokes its getter, while the getter owns baz(). Adopt
// the upstream getter-call semantics and canonical C::bar scope; these queries avoid the separate
// constructor call from foo.
#[tokio::test]
async fn typescript_getter_calls() {
    let entry = description("foo", "accessor.ts", 1, 3);
    let getter = description("C::bar", "accessor.ts", 6, 8);
    let target = description("baz", "accessor.ts", 11, 12);
    check_case(Case {
        name: "typescript_getter_calls",
        files: vec![
            SourceFile { path: "accessor.ts", source: "function foo() {\n    new C().bar;\n}\n\nclass C {\n    get bar() {\n        return baz();\n    }\n}\n\nfunction baz() {\n}\n" },
        ],
        queries: vec![
            Query { direction: "in", symbol: "C::bar", expected: vec![
                relationships(&getter, &[(&entry, 2, 12)]),
            ] },
            Query { direction: "out", symbol: "C::bar", expected: vec![
                relationships(&getter, &[(&target, 7, 15)]),
            ] },
            Query { direction: "in", symbol: "baz", expected: vec![
                relationships(&target, &[(&getter, 7, 15)]),
            ] },
        ],
    }).await;
}

// https://github.com/microsoft/TypeScript/blob/fed0bf24149fb1ed36039212648bafdafc1ea10e/tsc/internal/fourslash/tests/callHierarchyUnclosedTemplateExprNoCrash1_test.go
// Adapt the malformed-template source from the upstream no-crash regression. Prefix an independent
// valid target and caller, and query those instead of reproducing the LSP cursor protocol. The
// added relationship assertions require error recovery to preserve valid code without inventing
// calls from the broken template.
#[tokio::test]
async fn typescript_malformed_template_preserves_valid_calls() {
    let target = description("target", "broken.ts", 1, 1);
    let entry = description("caller", "broken.ts", 2, 2);
    check_case(Case {
        name: "typescript_malformed_template_preserves_valid_calls",
        files: vec![
            SourceFile { path: "broken.ts", source: "function target() {}\nfunction caller() { target(); }\nfunction updateBadge() {\n    const header = `<div class=\"sub\">${format`;\n    const badge = `<div class=\"badge\">`;\n}\n" },
        ],
        queries: vec![
            Query { direction: "in", symbol: "target", expected: vec![
                relationships(&target, &[(&entry, 2, 20)]),
            ] },
            Query { direction: "out", symbol: "caller", expected: vec![
                relationships(&entry, &[(&target, 2, 20)]),
            ] },
        ],
    }).await;
}

// zvec-grep-specific regression for reference-versus-call semantics. Assigning target to alias is
// not a calls edge; alias() is. The no-call holder must not appear in target callers. This
// deliberately tests actual invocation semantics rather than copying LSP implementations that
// count bare references as calls.
#[tokio::test]
async fn python_function_reference_and_alias_call() {
    let target = description("target", "references.py", 1, 2);
    let holder = description("holder", "references.py", 4, 6);
    let entry = description("caller", "references.py", 8, 10);
    check_case(Case {
        name: "python_function_reference_and_alias_call",
        files: vec![
            SourceFile { path: "references.py", source: "def target():\n    pass\n\ndef holder():\n    alias = target\n    return alias\n\ndef caller():\n    alias = target\n    alias()\n" },
        ],
        queries: vec![
            Query { direction: "in", symbol: "target", expected: vec![
                relationships(&target, &[(&entry, 10, 4)]),
            ] },
            Query { direction: "out", symbol: "holder", expected: vec![
                relationships(&holder, &[]),
            ] },
            Query { direction: "out", symbol: "caller", expected: vec![
                relationships(&entry, &[(&target, 10, 4)]),
            ] },
        ],
    }).await;
}

// https://github.com/eclipse-cdt/cdt/blob/4c37839cfbe3dde7bdfa398d9f703644052f5429/core/org.eclipse.cdt.ui.tests/ui/org/eclipse/cdt/ui/tests/callhierarchy/BasicCallHierarchyTest.java
// CDT IDE testFunctionsC. Preserve its prototype-only target and function definition while using
// standard int main(void) syntax. A declared external prototype is a known symbol; main has one
// call to proto and one to func. Incoming expectations come from the upstream tree, outgoing is
// their inverse.
#[tokio::test]
async fn c_prototype_and_definition_calls() {
    let prototype = description("proto", "functions.c", 1, 1);
    let defined = description("func", "functions.c", 2, 3);
    let entry = description("main", "functions.c", 4, 8);
    check_case(Case {
        name: "c_prototype_and_definition_calls",
        files: vec![
            SourceFile { path: "functions.c", source: "void proto(void);\nvoid func(void) {\n}\nint main(void) {\n   proto();\n   func();\n   return 0;\n}\n" },
        ],
        queries: vec![
            Query { direction: "in", symbol: "proto", expected: vec![
                relationships(&prototype, &[(&entry, 5, 3)]),
            ] },
            Query { direction: "in", symbol: "func", expected: vec![
                relationships(&defined, &[(&entry, 6, 3)]),
            ] },
            Query { direction: "out", symbol: "main", expected: vec![
                relationships(&entry, &[(&prototype, 5, 3), (&defined, 6, 3)]),
            ] },
        ],
    }).await;
}

// https://github.com/razzmatazz/csharp-language-server/blob/72671fc7fa810c158864e72485db68e8b9b25c3d/tests/CSharpLanguageServer.Tests/CallHierarchyTests.fs
// Translate the this/base constructor-chain scenario from csharp-ls
// testCallHierarchyOutgoingCallsIncludeConstructorInitializers into Java this/super syntax. This
// is not a C# parser test or a verbatim Java upstream case. Query both same-named Derived
// constructor definitions separately; the parameterless constructor targets the sized constructor,
// which targets Base.
#[tokio::test]
async fn java_explicit_constructor_chain() {
    let base = description("Base::Base", "Constructors.java", 2, 2);
    let default_ctor = description("Derived::Derived", "Constructors.java", 5, 7);
    let sized_ctor = description("Derived::Derived", "Constructors.java", 8, 10);
    check_case(Case {
        name: "java_explicit_constructor_chain",
        files: vec![
            SourceFile { path: "Constructors.java", source: "class Base {\n    Base(int size) {}\n}\nclass Derived extends Base {\n    Derived() {\n        this(5);\n    }\n    Derived(int size) {\n        super(size);\n    }\n}\n" },
        ],
        queries: vec![
            Query { direction: "out", symbol: "Derived::Derived", expected: vec![
                relationships(&default_ctor, &[(&sized_ctor, 6, 8)]),
                relationships(&sized_ctor, &[(&base, 9, 8)]),
            ] },
            Query { direction: "in", symbol: "Derived::Derived", expected: vec![
                relationships(&default_ctor, &[]),
                relationships(&sized_ctor, &[(&default_ctor, 6, 8)]),
            ] },
            Query { direction: "in", symbol: "Base::Base", expected: vec![
                relationships(&base, &[(&sized_ctor, 9, 8)]),
            ] },
        ],
    }).await;
}

// zvec-grep-specific regression. Three overloads differ by arity or parameter type. Calls with no
// argument, integer and string must bind to the corresponding definition rather than all same-
// named functions. Unqualified callers lookup preserves three definition groups.
#[tokio::test]
async fn cpp_overload_arity_and_type() {
    let empty = description("run", "overloads.cc", 1, 1);
    let integer = description("run", "overloads.cc", 2, 2);
    let string = description("run", "overloads.cc", 3, 3);
    let entry = description("caller", "overloads.cc", 4, 8);
    check_case(Case {
        name: "cpp_overload_arity_and_type",
        files: vec![
            SourceFile { path: "overloads.cc", source: "void run() {}\nvoid run(int value) {}\nvoid run(const char *value) {}\nvoid caller() {\n    run();\n    run(1);\n    run(\"text\");\n}\n" },
        ],
        queries: vec![
            Query { direction: "in", symbol: "run", expected: vec![
                relationships(&empty, &[(&entry, 5, 4)]),
                relationships(&integer, &[(&entry, 6, 4)]),
                relationships(&string, &[(&entry, 7, 4)]),
            ] },
            Query { direction: "out", symbol: "caller", expected: vec![
                relationships(&entry, &[(&empty, 5, 4), (&integer, 6, 4), (&string, 7, 4)]),
            ] },
        ],
    }).await;
}

// zvec-grep regression: extend typescript_same_name_scopes to rust.
// Modules provide separate lexical namespaces.
// Bare-name queries preserve both groups; each group must contain only its own callsite.
#[tokio::test]
async fn rust_same_name_scopes() {
    let left_target = description("left::work", "scopes.rs", 2, 2);
    let left_entry = description("left::caller", "scopes.rs", 3, 5);
    let right_target = description("right::work", "scopes.rs", 8, 8);
    let right_entry = description("right::caller", "scopes.rs", 9, 11);
    check_case(Case {
        name: "rust_same_name_scopes",
        files: vec![SourceFile {
            path: "scopes.rs",
            source: r"mod left {
    pub fn work() {}
    pub fn caller() {
        work();
    }
}
mod right {
    pub fn work() {}
    pub fn caller() {
        work();
    }
}
",
        }],
        queries: vec![
            Query {
                direction: "in",
                symbol: "work",
                expected: vec![
                    relationships(&left_target, &[(&left_entry, 4, 8)]),
                    relationships(&right_target, &[(&right_entry, 10, 8)]),
                ],
            },
            Query {
                direction: "out",
                symbol: "caller",
                expected: vec![
                    relationships(&left_entry, &[(&left_target, 4, 8)]),
                    relationships(&right_entry, &[(&right_target, 10, 8)]),
                ],
            },
            Query {
                direction: "in",
                symbol: "left::work",
                expected: vec![relationships(&left_target, &[(&left_entry, 4, 8)])],
            },
            Query {
                direction: "out",
                symbol: "left::caller",
                expected: vec![relationships(&left_entry, &[(&left_target, 4, 8)])],
            },
            Query {
                direction: "in",
                symbol: "right::work",
                expected: vec![relationships(&right_target, &[(&right_entry, 10, 8)])],
            },
            Query {
                direction: "out",
                symbol: "right::caller",
                expected: vec![relationships(&right_entry, &[(&right_target, 10, 8)])],
            },
        ],
    })
    .await;
}

// zvec-grep regression: extend typescript_same_name_scopes to cpp.
// Namespaces provide separate lexical lookup environments.
// Bare-name queries preserve both groups; each group must contain only its own callsite.
#[tokio::test]
async fn cpp_same_name_scopes() {
    let left_target = description("Left::work", "scopes.cc", 2, 2);
    let left_entry = description("Left::caller", "scopes.cc", 3, 5);
    let right_target = description("Right::work", "scopes.cc", 8, 8);
    let right_entry = description("Right::caller", "scopes.cc", 9, 11);
    check_case(Case {
        name: "cpp_same_name_scopes",
        files: vec![SourceFile {
            path: "scopes.cc",
            source: r"namespace Left {
    void work() {}
    void caller() {
        work();
    }
}
namespace Right {
    void work() {}
    void caller() {
        work();
    }
}
",
        }],
        queries: vec![
            Query {
                direction: "in",
                symbol: "work",
                expected: vec![
                    relationships(&left_target, &[(&left_entry, 4, 8)]),
                    relationships(&right_target, &[(&right_entry, 10, 8)]),
                ],
            },
            Query {
                direction: "out",
                symbol: "caller",
                expected: vec![
                    relationships(&left_entry, &[(&left_target, 4, 8)]),
                    relationships(&right_entry, &[(&right_target, 10, 8)]),
                ],
            },
            Query {
                direction: "in",
                symbol: "Left::work",
                expected: vec![relationships(&left_target, &[(&left_entry, 4, 8)])],
            },
            Query {
                direction: "out",
                symbol: "Left::caller",
                expected: vec![relationships(&left_entry, &[(&left_target, 4, 8)])],
            },
            Query {
                direction: "in",
                symbol: "Right::work",
                expected: vec![relationships(&right_target, &[(&right_entry, 10, 8)])],
            },
            Query {
                direction: "out",
                symbol: "Right::caller",
                expected: vec![relationships(&right_entry, &[(&right_target, 10, 8)])],
            },
        ],
    })
    .await;
}

// zvec-grep regression: extend typescript_same_name_scopes to java.
// Unqualified static calls bind inside their declaring class.
// Bare-name queries preserve both groups; each group must contain only its own callsite.
#[tokio::test]
async fn java_same_name_scopes() {
    let left_target = description("Left::work", "Scopes.java", 2, 2);
    let left_entry = description("Left::caller", "Scopes.java", 3, 5);
    let right_target = description("Right::work", "Scopes.java", 8, 8);
    let right_entry = description("Right::caller", "Scopes.java", 9, 11);
    check_case(Case {
        name: "java_same_name_scopes",
        files: vec![SourceFile {
            path: "Scopes.java",
            source: r"class Left {
    static void work() {}
    static void caller() {
        work();
    }
}
class Right {
    static void work() {}
    static void caller() {
        work();
    }
}
",
        }],
        queries: vec![
            Query {
                direction: "in",
                symbol: "work",
                expected: vec![
                    relationships(&left_target, &[(&left_entry, 4, 8)]),
                    relationships(&right_target, &[(&right_entry, 10, 8)]),
                ],
            },
            Query {
                direction: "out",
                symbol: "caller",
                expected: vec![
                    relationships(&left_entry, &[(&left_target, 4, 8)]),
                    relationships(&right_entry, &[(&right_target, 10, 8)]),
                ],
            },
            Query {
                direction: "in",
                symbol: "Left::work",
                expected: vec![relationships(&left_target, &[(&left_entry, 4, 8)])],
            },
            Query {
                direction: "out",
                symbol: "Left::caller",
                expected: vec![relationships(&left_entry, &[(&left_target, 4, 8)])],
            },
            Query {
                direction: "in",
                symbol: "Right::work",
                expected: vec![relationships(&right_target, &[(&right_entry, 10, 8)])],
            },
            Query {
                direction: "out",
                symbol: "Right::caller",
                expected: vec![relationships(&right_entry, &[(&right_target, 10, 8)])],
            },
        ],
    })
    .await;
}

// zvec-grep regression: extend typescript_same_name_scopes to javascript.
// Resolve this.work() against the enclosing receiver class.
// Bare-name queries preserve both groups; each group must contain only its own callsite.
#[tokio::test]
async fn javascript_same_name_scopes() {
    let left_target = description("Left::work", "scopes.js", 2, 2);
    let left_entry = description("Left::caller", "scopes.js", 3, 5);
    let right_target = description("Right::work", "scopes.js", 8, 8);
    let right_entry = description("Right::caller", "scopes.js", 9, 11);
    check_case(Case {
        name: "javascript_same_name_scopes",
        files: vec![SourceFile {
            path: "scopes.js",
            source: r"class Left {
    work() {}
    caller() {
        this.work();
    }
}
class Right {
    work() {}
    caller() {
        this.work();
    }
}
",
        }],
        queries: vec![
            Query {
                direction: "in",
                symbol: "work",
                expected: vec![
                    relationships(&left_target, &[(&left_entry, 4, 13)]),
                    relationships(&right_target, &[(&right_entry, 10, 13)]),
                ],
            },
            Query {
                direction: "out",
                symbol: "caller",
                expected: vec![
                    relationships(&left_entry, &[(&left_target, 4, 13)]),
                    relationships(&right_entry, &[(&right_target, 10, 13)]),
                ],
            },
            Query {
                direction: "in",
                symbol: "Left::work",
                expected: vec![relationships(&left_target, &[(&left_entry, 4, 13)])],
            },
            Query {
                direction: "out",
                symbol: "Left::caller",
                expected: vec![relationships(&left_entry, &[(&left_target, 4, 13)])],
            },
            Query {
                direction: "in",
                symbol: "Right::work",
                expected: vec![relationships(&right_target, &[(&right_entry, 10, 13)])],
            },
            Query {
                direction: "out",
                symbol: "Right::caller",
                expected: vec![relationships(&right_entry, &[(&right_target, 10, 13)])],
            },
        ],
    })
    .await;
}

// zvec-grep regression: extend typescript_same_name_scopes to python.
// Resolve self.work() against the enclosing receiver class.
// Bare-name queries preserve both groups; each group must contain only its own callsite.
#[tokio::test]
async fn python_same_name_scopes() {
    let left_target = description("Left::work", "scopes.py", 2, 3);
    let left_entry = description("Left::caller", "scopes.py", 4, 5);
    let right_target = description("Right::work", "scopes.py", 8, 9);
    let right_entry = description("Right::caller", "scopes.py", 10, 11);
    check_case(Case {
        name: "python_same_name_scopes",
        files: vec![SourceFile {
            path: "scopes.py",
            source: r"class Left:
    def work(self):
        pass
    def caller(self):
        self.work()

class Right:
    def work(self):
        pass
    def caller(self):
        self.work()
",
        }],
        queries: vec![
            Query {
                direction: "in",
                symbol: "work",
                expected: vec![
                    relationships(&left_target, &[(&left_entry, 5, 13)]),
                    relationships(&right_target, &[(&right_entry, 11, 13)]),
                ],
            },
            Query {
                direction: "out",
                symbol: "caller",
                expected: vec![
                    relationships(&left_entry, &[(&left_target, 5, 13)]),
                    relationships(&right_entry, &[(&right_target, 11, 13)]),
                ],
            },
            Query {
                direction: "in",
                symbol: "Left::work",
                expected: vec![relationships(&left_target, &[(&left_entry, 5, 13)])],
            },
            Query {
                direction: "out",
                symbol: "Left::caller",
                expected: vec![relationships(&left_entry, &[(&left_target, 5, 13)])],
            },
            Query {
                direction: "in",
                symbol: "Right::work",
                expected: vec![relationships(&right_target, &[(&right_entry, 11, 13)])],
            },
            Query {
                direction: "out",
                symbol: "Right::caller",
                expected: vec![relationships(&right_entry, &[(&right_target, 11, 13)])],
            },
        ],
    })
    .await;
}

// zvec-grep regression: extend typescript_same_name_scopes to go.
// Receiver types, including a pointer receiver on Right, disambiguate same-named methods.
// Bare-name queries preserve both groups; each group must contain only its own callsite.
#[tokio::test]
async fn go_same_name_scopes() {
    let left_target = description("Left::work", "scopes.go", 4, 4);
    let left_entry = description("Left::caller", "scopes.go", 5, 7);
    let right_target = description("Right::work", "scopes.go", 10, 10);
    let right_entry = description("Right::caller", "scopes.go", 11, 13);
    check_case(Case {
        name: "go_same_name_scopes",
        files: vec![SourceFile {
            path: "scopes.go",
            source: r"package scopes

type Left struct{}
func (self Left) work() {}
func (self Left) caller() {
    self.work()
}

type Right struct{}
func (self *Right) work() {}
func (self *Right) caller() {
    self.work()
}
",
        }],
        queries: vec![
            Query {
                direction: "in",
                symbol: "work",
                expected: vec![
                    relationships(&left_target, &[(&left_entry, 6, 9)]),
                    relationships(&right_target, &[(&right_entry, 12, 9)]),
                ],
            },
            Query {
                direction: "out",
                symbol: "caller",
                expected: vec![
                    relationships(&left_entry, &[(&left_target, 6, 9)]),
                    relationships(&right_entry, &[(&right_target, 12, 9)]),
                ],
            },
            Query {
                direction: "in",
                symbol: "Left::work",
                expected: vec![relationships(&left_target, &[(&left_entry, 6, 9)])],
            },
            Query {
                direction: "out",
                symbol: "Left::caller",
                expected: vec![relationships(&left_entry, &[(&left_target, 6, 9)])],
            },
            Query {
                direction: "in",
                symbol: "Right::work",
                expected: vec![relationships(&right_target, &[(&right_entry, 12, 9)])],
            },
            Query {
                direction: "out",
                symbol: "Right::caller",
                expected: vec![relationships(&right_entry, &[(&right_target, 12, 9)])],
            },
        ],
    })
    .await;
}

// zvec-grep regression: extend typescript_same_name_scopes to c.
// C has no namespace qualifier in this API: distinguish file-local static symbols by file
// identity. Identical contents in two files must still yield separate definitions.
// Bare-name queries preserve both groups; each group must contain only its own callsite.
#[tokio::test]
async fn c_same_name_scopes() {
    let left_target = description("work", "left.c", 1, 1);
    let left_entry = description("caller", "left.c", 2, 4);
    let right_target = description("work", "right.c", 1, 1);
    let right_entry = description("caller", "right.c", 2, 4);
    check_case(Case {
        name: "c_same_name_scopes",
        files: vec![
            SourceFile {
                path: "left.c",
                source: r"static void work(void) {}
static void caller(void) {
    work();
}
",
            },
            SourceFile {
                path: "right.c",
                source: r"static void work(void) {}
static void caller(void) {
    work();
}
",
            },
        ],
        queries: vec![
            Query {
                direction: "in",
                symbol: "work",
                expected: vec![
                    relationships(&left_target, &[(&left_entry, 3, 4)]),
                    relationships(&right_target, &[(&right_entry, 3, 4)]),
                ],
            },
            Query {
                direction: "out",
                symbol: "caller",
                expected: vec![
                    relationships(&left_entry, &[(&left_target, 3, 4)]),
                    relationships(&right_entry, &[(&right_target, 3, 4)]),
                ],
            },
        ],
    })
    .await;
}

// zvec-grep-specific lexical-shadowing and caller-ownership regression. The nested work shadows
// the global work. Its call to target belongs only to outer::work, not outer; outer has only the
// direct call to the nested work. Canonical nested-function names use the containing function
// scope.
#[tokio::test]
async fn rust_shadowed_nested_function() {
    let global = description("work", "shadow.rs", 1, 1);
    let target = description("target", "shadow.rs", 2, 2);
    let outer = description("outer", "shadow.rs", 3, 8);
    let inner = description("outer::work", "shadow.rs", 4, 6);
    check_case(Case {
        name: "rust_shadowed_nested_function",
        files: vec![SourceFile {
            path: "shadow.rs",
            source: r"fn work() {}
fn target() {}
fn outer() {
    fn work() {
        target();
    }
    work();
}
",
        }],
        queries: vec![
            Query {
                direction: "in",
                symbol: "work",
                expected: vec![
                    relationships(&global, &[]),
                    relationships(&inner, &[(&outer, 7, 4)]),
                ],
            },
            Query {
                direction: "in",
                symbol: "target",
                expected: vec![relationships(&target, &[(&inner, 5, 8)])],
            },
            Query {
                direction: "out",
                symbol: "outer",
                expected: vec![relationships(&outer, &[(&inner, 7, 4)])],
            },
            Query {
                direction: "out",
                symbol: "outer::work",
                expected: vec![relationships(&inner, &[(&target, 5, 8)])],
            },
        ],
    })
    .await;
}

// zvec-grep-specific lexical-shadowing and caller-ownership regression. The nested work shadows
// the global work. Its call to target belongs only to outer::work, not outer; outer has only the
// direct call to the nested work. Canonical nested-function names use the containing function
// scope.
#[tokio::test]
async fn javascript_shadowed_nested_function() {
    let global = description("work", "shadow.js", 1, 1);
    let target = description("target", "shadow.js", 2, 2);
    let outer = description("outer", "shadow.js", 3, 8);
    let inner = description("outer::work", "shadow.js", 4, 6);
    check_case(Case {
        name: "javascript_shadowed_nested_function",
        files: vec![SourceFile {
            path: "shadow.js",
            source: r"function work() {}
function target() {}
function outer() {
    function work() {
        target();
    }
    work();
}
",
        }],
        queries: vec![
            Query {
                direction: "in",
                symbol: "work",
                expected: vec![
                    relationships(&global, &[]),
                    relationships(&inner, &[(&outer, 7, 4)]),
                ],
            },
            Query {
                direction: "in",
                symbol: "target",
                expected: vec![relationships(&target, &[(&inner, 5, 8)])],
            },
            Query {
                direction: "out",
                symbol: "outer",
                expected: vec![relationships(&outer, &[(&inner, 7, 4)])],
            },
            Query {
                direction: "out",
                symbol: "outer::work",
                expected: vec![relationships(&inner, &[(&target, 5, 8)])],
            },
        ],
    })
    .await;
}

// zvec-grep-specific lexical-shadowing and caller-ownership regression. The nested work shadows
// the global work. Its call to target belongs only to outer::work, not outer; outer has only the
// direct call to the nested work. Canonical nested-function names use the containing function
// scope.
#[tokio::test]
async fn python_shadowed_nested_function() {
    let global = description("work", "shadow.py", 1, 2);
    let target = description("target", "shadow.py", 3, 4);
    let outer = description("outer", "shadow.py", 5, 8);
    let inner = description("outer::work", "shadow.py", 6, 7);
    check_case(Case {
        name: "python_shadowed_nested_function",
        files: vec![SourceFile {
            path: "shadow.py",
            source: r"def work():
    pass
def target():
    pass
def outer():
    def work():
        target()
    work()
",
        }],
        queries: vec![
            Query {
                direction: "in",
                symbol: "work",
                expected: vec![
                    relationships(&global, &[]),
                    relationships(&inner, &[(&outer, 8, 4)]),
                ],
            },
            Query {
                direction: "in",
                symbol: "target",
                expected: vec![relationships(&target, &[(&inner, 7, 8)])],
            },
            Query {
                direction: "out",
                symbol: "outer",
                expected: vec![relationships(&outer, &[(&inner, 8, 4)])],
            },
            Query {
                direction: "out",
                symbol: "outer::work",
                expected: vec![relationships(&inner, &[(&target, 7, 8)])],
            },
        ],
    })
    .await;
}

// zvec-grep-specific C shadowing regression. The local function pointer work hides the global work
// function, and its known initializer is target. Assignment is not a call; invoking work() reaches
// target, not the global same-named function.
#[tokio::test]
async fn c_local_function_pointer_shadows_global() {
    let global = description("work", "shadow.c", 1, 1);
    let target = description("target", "shadow.c", 2, 2);
    let entry = description("caller", "shadow.c", 3, 6);
    check_case(Case {
        name: "c_local_function_pointer_shadows_global",
        files: vec![SourceFile {
            path: "shadow.c",
            source: r"void work(void) {}
void target(void) {}
void caller(void) {
    void (*work)(void) = target;
    work();
}
",
        }],
        queries: vec![
            Query {
                direction: "in",
                symbol: "work",
                expected: vec![relationships(&global, &[])],
            },
            Query {
                direction: "in",
                symbol: "target",
                expected: vec![relationships(&target, &[(&entry, 5, 4)])],
            },
            Query {
                direction: "out",
                symbol: "caller",
                expected: vec![relationships(&entry, &[(&target, 5, 4)])],
            },
        ],
    })
    .await;
}

// zvec-grep-specific receiver-binding regression. Parameters a and b have different declared types
// with same-named run methods. Each callsite binds to its receiver type; neither target may
// inherit the other receiver call. This exercises parameters, not only self/this calls inside
// methods.
#[tokio::test]
async fn typescript_different_parameter_receivers() {
    let left = description("Left::run", "receivers.ts", 2, 2);
    let right = description("Right::run", "receivers.ts", 5, 5);
    let entry = description("caller", "receivers.ts", 7, 10);
    check_case(Case {
        name: "typescript_different_parameter_receivers",
        files: vec![SourceFile {
            path: "receivers.ts",
            source: r"class Left {
    run() {}
}
class Right {
    run() {}
}
function caller(a: Left, b: Right) {
    a.run();
    b.run();
}
",
        }],
        queries: vec![
            Query {
                direction: "out",
                symbol: "caller",
                expected: vec![relationships(&entry, &[(&left, 8, 6), (&right, 9, 6)])],
            },
            Query {
                direction: "in",
                symbol: "Left::run",
                expected: vec![relationships(&left, &[(&entry, 8, 6)])],
            },
            Query {
                direction: "in",
                symbol: "Right::run",
                expected: vec![relationships(&right, &[(&entry, 9, 6)])],
            },
        ],
    })
    .await;
}

// zvec-grep-specific receiver-binding regression. Parameters a and b have different declared types
// with same-named run methods. Each callsite binds to its receiver type; neither target may
// inherit the other receiver call. This exercises parameters, not only self/this calls inside
// methods.
#[tokio::test]
async fn java_different_parameter_receivers() {
    let left = description("Left::run", "Receivers.java", 2, 2);
    let right = description("Right::run", "Receivers.java", 5, 5);
    let entry = description("Use::caller", "Receivers.java", 8, 11);
    check_case(Case {
        name: "java_different_parameter_receivers",
        files: vec![SourceFile {
            path: "Receivers.java",
            source: r"class Left {
    void run() {}
}
class Right {
    void run() {}
}
class Use {
    static void caller(Left a, Right b) {
        a.run();
        b.run();
    }
}
",
        }],
        queries: vec![
            Query {
                direction: "out",
                symbol: "Use::caller",
                expected: vec![relationships(&entry, &[(&left, 9, 10), (&right, 10, 10)])],
            },
            Query {
                direction: "in",
                symbol: "Left::run",
                expected: vec![relationships(&left, &[(&entry, 9, 10)])],
            },
            Query {
                direction: "in",
                symbol: "Right::run",
                expected: vec![relationships(&right, &[(&entry, 10, 10)])],
            },
        ],
    })
    .await;
}

// zvec-grep-specific receiver-binding regression. Parameters a and b have different declared types
// with same-named run methods. Each callsite binds to its receiver type; neither target may
// inherit the other receiver call. This exercises parameters, not only self/this calls inside
// methods.
#[tokio::test]
async fn cpp_different_parameter_receivers() {
    let left = description("Left::run", "receivers.cc", 2, 2);
    let right = description("Right::run", "receivers.cc", 5, 5);
    let entry = description("caller", "receivers.cc", 7, 10);
    check_case(Case {
        name: "cpp_different_parameter_receivers",
        files: vec![SourceFile {
            path: "receivers.cc",
            source: r"struct Left {
    void run() {}
};
struct Right {
    void run() {}
};
void caller(Left &a, Right &b) {
    a.run();
    b.run();
}
",
        }],
        queries: vec![
            Query {
                direction: "out",
                symbol: "caller",
                expected: vec![relationships(&entry, &[(&left, 8, 6), (&right, 9, 6)])],
            },
            Query {
                direction: "in",
                symbol: "Left::run",
                expected: vec![relationships(&left, &[(&entry, 8, 6)])],
            },
            Query {
                direction: "in",
                symbol: "Right::run",
                expected: vec![relationships(&right, &[(&entry, 9, 6)])],
            },
        ],
    })
    .await;
}

// zvec-grep-specific receiver-binding regression. Parameters a and b have different declared types
// with same-named run methods. Each callsite binds to its receiver type; neither target may
// inherit the other receiver call. This exercises parameters, not only self/this calls inside
// methods.
#[tokio::test]
async fn go_different_parameter_receivers() {
    let left = description("Left::run", "receivers.go", 4, 4);
    let right = description("Right::run", "receivers.go", 6, 6);
    let entry = description("caller", "receivers.go", 7, 10);
    check_case(Case {
        name: "go_different_parameter_receivers",
        files: vec![SourceFile {
            path: "receivers.go",
            source: r"package receivers

type Left struct{}
func (a Left) run() {}
type Right struct{}
func (b *Right) run() {}
func caller(a Left, b *Right) {
    a.run()
    b.run()
}
",
        }],
        queries: vec![
            Query {
                direction: "out",
                symbol: "caller",
                expected: vec![relationships(&entry, &[(&left, 8, 6), (&right, 9, 6)])],
            },
            Query {
                direction: "in",
                symbol: "Left::run",
                expected: vec![relationships(&left, &[(&entry, 8, 6)])],
            },
            Query {
                direction: "in",
                symbol: "Right::run",
                expected: vec![relationships(&right, &[(&entry, 9, 6)])],
            },
        ],
    })
    .await;
}

// zvec-grep-specific import-binding regression. Import two same-named definitions through
// different aliases. Preserve their canonical definitions and source paths; aliases and import
// statements themselves are not calls. The same-named query returns two groups without exchanging
// callsites.
#[tokio::test]
async fn python_aliased_imports_of_same_name() {
    let left = description("work", "left.py", 1, 2);
    let right = description("work", "right.py", 1, 2);
    let entry = description("caller", "caller.py", 3, 5);
    check_case(Case {
        name: "python_aliased_imports_of_same_name",
        files: vec![
            SourceFile {
                path: "left.py",
                source: r"def work():
    pass
",
            },
            SourceFile {
                path: "right.py",
                source: r"def work():
    pass
",
            },
            SourceFile {
                path: "caller.py",
                source: r"from left import work as left_work
from right import work as right_work
def caller():
    left_work()
    right_work()
",
            },
        ],
        queries: vec![
            Query {
                direction: "out",
                symbol: "caller",
                expected: vec![relationships(&entry, &[(&left, 4, 4), (&right, 5, 4)])],
            },
            Query {
                direction: "in",
                symbol: "work",
                expected: vec![
                    relationships(&left, &[(&entry, 4, 4)]),
                    relationships(&right, &[(&entry, 5, 4)]),
                ],
            },
        ],
    })
    .await;
}

// zvec-grep-specific import-binding regression. Import two same-named definitions through
// different aliases. Preserve their canonical definitions and source paths; aliases and import
// statements themselves are not calls. The same-named query returns two groups without exchanging
// callsites.
#[tokio::test]
async fn typescript_aliased_imports_of_same_name() {
    let left = description("work", "left.ts", 1, 1);
    let right = description("work", "right.ts", 1, 1);
    let entry = description("caller", "caller.ts", 3, 6);
    check_case(Case {
        name: "typescript_aliased_imports_of_same_name",
        files: vec![
            SourceFile {
                path: "left.ts",
                source: r"export function work() {}
",
            },
            SourceFile {
                path: "right.ts",
                source: r"export function work() {}
",
            },
            SourceFile {
                path: "caller.ts",
                source: r"import { work as leftWork } from './left';
import { work as rightWork } from './right';
function caller() {
    leftWork();
    rightWork();
}
",
            },
        ],
        queries: vec![
            Query {
                direction: "out",
                symbol: "caller",
                expected: vec![relationships(&entry, &[(&left, 4, 4), (&right, 5, 4)])],
            },
            Query {
                direction: "in",
                symbol: "work",
                expected: vec![
                    relationships(&left, &[(&entry, 4, 4)]),
                    relationships(&right, &[(&entry, 5, 4)]),
                ],
            },
        ],
    })
    .await;
}

// zvec-grep-specific import-binding regression. Import two same-named definitions through
// different aliases. Preserve their canonical definitions and source paths; aliases and import
// statements themselves are not calls. The same-named query returns two groups without exchanging
// callsites.
#[tokio::test]
async fn rust_aliased_imports_of_same_name() {
    let left = description("left::work", "left.rs", 1, 1);
    let right = description("right::work", "right.rs", 1, 1);
    let entry = description("caller", "lib.rs", 5, 8);
    check_case(Case {
        name: "rust_aliased_imports_of_same_name",
        files: vec![
            SourceFile {
                path: "left.rs",
                source: r"pub fn work() {}
",
            },
            SourceFile {
                path: "right.rs",
                source: r"pub fn work() {}
",
            },
            SourceFile {
                path: "lib.rs",
                source: r"mod left;
mod right;
use left::work as left_work;
use right::work as right_work;
fn caller() {
    left_work();
    right_work();
}
",
            },
        ],
        queries: vec![
            Query {
                direction: "out",
                symbol: "caller",
                expected: vec![relationships(&entry, &[(&left, 6, 4), (&right, 7, 4)])],
            },
            Query {
                direction: "in",
                symbol: "work",
                expected: vec![
                    relationships(&left, &[(&entry, 6, 4)]),
                    relationships(&right, &[(&entry, 7, 4)]),
                ],
            },
        ],
    })
    .await;
}

// zvec-grep-specific import-binding regression. Import two same-named definitions through
// different aliases. Preserve their canonical definitions and source paths; aliases and import
// statements themselves are not calls. The same-named query returns two groups without exchanging
// callsites.
#[tokio::test]
async fn go_aliased_imports_of_same_name() {
    let left = description("Work", "left/left.go", 3, 3);
    let right = description("Work", "right/right.go", 3, 3);
    let entry = description("caller", "caller.go", 8, 11);
    check_case(Case {
        name: "go_aliased_imports_of_same_name",
        files: vec![
            SourceFile {
                path: "go.mod",
                source: r"module example.com/calls
go 1.17
",
            },
            SourceFile {
                path: "left/left.go",
                source: r"package left

func Work() {}
",
            },
            SourceFile {
                path: "right/right.go",
                source: r"package right

func Work() {}
",
            },
            SourceFile {
                path: "caller.go",
                source: r#"package calls

import (
    l "example.com/calls/left"
    r "example.com/calls/right"
)

func caller() {
    l.Work()
    r.Work()
}
"#,
            },
        ],
        queries: vec![
            Query {
                direction: "out",
                symbol: "caller",
                expected: vec![relationships(&entry, &[(&left, 9, 6), (&right, 10, 6)])],
            },
            Query {
                direction: "in",
                symbol: "Work",
                expected: vec![
                    relationships(&left, &[(&entry, 9, 6)]),
                    relationships(&right, &[(&entry, 10, 6)]),
                ],
            },
        ],
    })
    .await;
}

// zvec-grep-specific re-export regression. leaf.work is re-exported as bridge.run and imported as
// invoke. Both directions must connect caller to the original leaf definition; the export and
// import aliases must not create intermediate calls edges.
#[tokio::test]
async fn typescript_reexport_alias_reaches_original_definition() {
    let target = description("work", "leaf.ts", 1, 1);
    let entry = description("caller", "caller.ts", 2, 4);
    check_case(Case {
        name: "typescript_reexport_alias_reaches_original_definition",
        files: vec![
            SourceFile {
                path: "leaf.ts",
                source: r"export function work() {}
",
            },
            SourceFile {
                path: "bridge.ts",
                source: r"export { work as run } from './leaf';
",
            },
            SourceFile {
                path: "caller.ts",
                source: r"import { run as invoke } from './bridge';
function caller() {
    invoke();
}
",
            },
        ],
        queries: vec![
            Query {
                direction: "in",
                symbol: "work",
                expected: vec![relationships(&target, &[(&entry, 3, 4)])],
            },
            Query {
                direction: "out",
                symbol: "caller",
                expected: vec![relationships(&entry, &[(&target, 3, 4)])],
            },
        ],
    })
    .await;
}

// zvec-grep-specific position regression. Two calls on one line follow Chinese characters and an
// emoji. Columns are UTF-8 byte offsets (31 and 41), not Unicode scalar or UTF-16 positions.
// Retain both edges even though source, target and line are equal.
#[tokio::test]
async fn javascript_unicode_prefix_and_repeated_same_line_calls() {
    let target = description("target", "positions.js", 1, 1);
    let entry = description("caller", "positions.js", 2, 4);
    check_case(Case {
        name: "javascript_unicode_prefix_and_repeated_same_line_calls",
        files: vec![SourceFile {
            path: "positions.js",
            source: r#"function target() {}
function caller() {
    const text = "中文😀"; target(); target();
}
"#,
        }],
        queries: vec![
            Query {
                direction: "in",
                symbol: "target",
                expected: vec![relationships(&target, &[(&entry, 3, 31), (&entry, 3, 41)])],
            },
            Query {
                direction: "out",
                symbol: "caller",
                expected: vec![relationships(&entry, &[(&target, 3, 31), (&target, 3, 41)])],
            },
        ],
    })
    .await;
}

// zvec-grep-specific position regression. Two calls on one line follow Chinese characters and an
// emoji. Columns are UTF-8 byte offsets (21 and 31), not Unicode scalar or UTF-16 positions.
// Retain both edges even though source, target and line are equal.
#[tokio::test]
async fn c_unicode_prefix_and_repeated_same_line_calls() {
    let target = description("target", "positions.c", 1, 1);
    let entry = description("caller", "positions.c", 2, 4);
    check_case(Case {
        name: "c_unicode_prefix_and_repeated_same_line_calls",
        files: vec![SourceFile {
            path: "positions.c",
            source: r"void target(void) {}
void caller(void) {
    /* 中文😀 */ target(); target();
}
",
        }],
        queries: vec![
            Query {
                direction: "in",
                symbol: "target",
                expected: vec![relationships(&target, &[(&entry, 3, 21), (&entry, 3, 31)])],
            },
            Query {
                direction: "out",
                symbol: "caller",
                expected: vec![relationships(&entry, &[(&target, 3, 21), (&target, 3, 31)])],
            },
        ],
    })
    .await;
}

// zvec-grep-specific incremental regression. Editing target content/range changes
// its canonical identity without deleting the file or changing the caller source.
#[tokio::test]
async fn incremental_target_edit_rebinds_unchanged_caller() {
    let workspace = IncrementalWorkspace::new().await;
    workspace.check_initial_calls("before target edit").await;
    fs::write(
        workspace.directory.path().join("targets.py"),
        "\n\ndef first():\n    return 42\n\ndef second():\n    pass\n",
    )
    .expect("edit target definition");
    let indexed = workspace
        .index(vec![WorkspaceChange::Upsert("targets.py".into())])
        .await;
    assert_eq!(indexed.files_modified, 1);
    assert_eq!(indexed.files_added + indexed.files_deleted, 0);
    let entry = description("caller", "caller.py", 2, 3);
    let target = description("first", "targets.py", 3, 4);
    workspace
        .check(
            "unchanged caller must point to the new target identity",
            &[
                Query {
                    direction: "out",
                    symbol: "caller",
                    expected: vec![relationships(&entry, &[(&target, 3, 4)])],
                },
                Query {
                    direction: "in",
                    symbol: "first",
                    expected: vec![relationships(&target, &[(&entry, 3, 4)])],
                },
            ],
        )
        .await;
}

// Moving a target must first invalidate the explicitly imported old path, even
// though a same-named function still exists elsewhere. Fixing the import then
// reconnects the caller to the moved definition, with its new path and identity.
#[tokio::test]
async fn incremental_target_move_then_import_edit_updates_path() {
    let workspace = IncrementalWorkspace::new().await;
    workspace.check_initial_calls("before target move").await;
    let root = workspace.directory.path();
    fs::rename(root.join("targets.py"), root.join("moved.py")).expect("move target");
    let moved = workspace
        .index(vec![
            WorkspaceChange::Delete("targets.py".into()),
            WorkspaceChange::Upsert("moved.py".into()),
        ])
        .await;
    assert_eq!((moved.files_added, moved.files_deleted), (1, 1));
    assert_eq!(moved.files_modified, 0);
    let entry = description("caller", "caller.py", 2, 3);
    let target = description("first", "moved.py", 1, 2);
    workspace
        .check(
            "old explicit import cannot resolve by unrelated workspace fallback",
            &[
                Query {
                    direction: "out",
                    symbol: "caller",
                    expected: vec![relationships(&entry, &[])],
                },
                Query {
                    direction: "in",
                    symbol: "first",
                    expected: vec![relationships(&target, &[])],
                },
            ],
        )
        .await;
    fs::write(
        root.join("caller.py"),
        "from moved import first, second\ndef caller():\n    first()\n",
    )
    .expect("update import");
    let updated = workspace
        .index(vec![WorkspaceChange::Upsert("caller.py".into())])
        .await;
    assert_eq!(updated.files_modified, 1);
    workspace
        .check(
            "updated import uses the moved definition and path",
            &[
                Query {
                    direction: "out",
                    symbol: "caller",
                    expected: vec![relationships(&entry, &[(&target, 3, 4)])],
                },
                Query {
                    direction: "in",
                    symbol: "first",
                    expected: vec![relationships(&target, &[(&entry, 3, 4)])],
                },
            ],
        )
        .await;
}

// Conservative workspace-unique fallback contract for global JavaScript scripts.
// Adding a second concrete same-named implementation removes uniqueness: leave
// the reference unresolved instead of retaining the previous arbitrary winner.
// This differs from the TypeScript overload-declaration case, whose upstream
// contract deliberately returns multiple canonical declaration candidates.
#[tokio::test]
async fn incremental_new_candidate_invalidates_unique_resolution() {
    let workspace = IncrementalWorkspace::from_sources(
        &[
            SourceFile {
                path: "one.js",
                source: "function work() {}\n",
            },
            SourceFile {
                path: "caller.js",
                source: "function caller() {\n    work();\n}\n",
            },
        ],
        "*.js",
    )
    .await;
    let entry = description("caller", "caller.js", 1, 3);
    let original = description("work", "one.js", 1, 1);
    let candidate = description("work", "two.js", 1, 1);
    let unique = [
        Query {
            direction: "out",
            symbol: "caller",
            expected: vec![relationships(&entry, &[(&original, 2, 4)])],
        },
        Query {
            direction: "in",
            symbol: "work",
            expected: vec![relationships(&original, &[(&entry, 2, 4)])],
        },
    ];
    workspace
        .check("initial unique workspace target", &unique)
        .await;
    fs::write(
        workspace.directory.path().join("two.js"),
        "function work() {}\n",
    )
    .expect("new candidate");
    let added = workspace
        .index(vec![WorkspaceChange::Upsert("two.js".into())])
        .await;
    assert_eq!(added.files_added, 1);
    assert_eq!(added.files_modified, 0);
    workspace
        .check(
            "new candidate invalidates the old unique resolution",
            &[
                Query {
                    direction: "out",
                    symbol: "caller",
                    expected: vec![relationships(&entry, &[])],
                },
                Query {
                    direction: "in",
                    symbol: "work",
                    expected: vec![
                        relationships(&original, &[]),
                        relationships(&candidate, &[]),
                    ],
                },
            ],
        )
        .await;
    fs::remove_file(workspace.directory.path().join("two.js")).expect("remove ambiguity");
    let deleted = workspace
        .index(vec![WorkspaceChange::Delete("two.js".into())])
        .await;
    assert_eq!(deleted.files_deleted, 1);
    workspace
        .check("removing the candidate restores unique resolution", &unique)
        .await;
}

// zvec-grep-specific C++ auto receiver regression.
// Infer auto x = new X() as X*, then resolve x->foo() to X::foo. The explicitly declared X
// constructor is a separate direct outgoing call. Y::foo must have no callers; matching only the
// foo name is insufficient.
#[tokio::test]
async fn cpp_auto_new_pointer_receiver() {
    let constructor = description("X::X", "auto.cc", 2, 2);
    let method = description("X::foo", "auto.cc", 3, 3);
    let other = description("Y::foo", "auto.cc", 6, 6);
    let entry = description("caller", "auto.cc", 8, 11);
    check_case(Case {
        name: "cpp_auto_new_pointer_receiver",
        files: vec![SourceFile {
            path: "auto.cc",
            source: r"struct X {
    X() {}
    void foo() {}
};
struct Y {
    void foo() {}
};
void caller() {
    auto x = new X();
    x->foo();
}
",
        }],
        queries: vec![
            Query {
                direction: "in",
                symbol: "foo",
                expected: vec![
                    relationships(&method, &[(&entry, 10, 7)]),
                    relationships(&other, &[]),
                ],
            },
            Query {
                direction: "out",
                symbol: "caller",
                expected: vec![relationships(
                    &entry,
                    &[(&constructor, 9, 17), (&method, 10, 7)],
                )],
            },
            Query {
                direction: "in",
                symbol: "Y::foo",
                expected: vec![relationships(&other, &[])],
            },
        ],
    })
    .await;
}

// zvec-grep-specific C++ auto receiver regression.
// Infer auto x = X{} as an X value and resolve x.foo(). Preserve the explicit constructor call at
// X{}, not at the variable name. Y::foo is an unrelated same-named method.
#[tokio::test]
async fn cpp_auto_value_receiver() {
    let constructor = description("X::X", "auto.cc", 2, 2);
    let method = description("X::foo", "auto.cc", 3, 3);
    let other = description("Y::foo", "auto.cc", 6, 6);
    let entry = description("caller", "auto.cc", 8, 11);
    check_case(Case {
        name: "cpp_auto_value_receiver",
        files: vec![SourceFile {
            path: "auto.cc",
            source: r"struct X {
    X() {}
    void foo() {}
};
struct Y {
    void foo() {}
};
void caller() {
    auto x = X{};
    x.foo();
}
",
        }],
        queries: vec![
            Query {
                direction: "in",
                symbol: "foo",
                expected: vec![
                    relationships(&method, &[(&entry, 10, 6)]),
                    relationships(&other, &[]),
                ],
            },
            Query {
                direction: "out",
                symbol: "caller",
                expected: vec![relationships(
                    &entry,
                    &[(&constructor, 9, 13), (&method, 10, 6)],
                )],
            },
            Query {
                direction: "in",
                symbol: "Y::foo",
                expected: vec![relationships(&other, &[])],
            },
        ],
    })
    .await;
}

// zvec-grep-specific C++ auto receiver regression.
// Infer x from the declared X return type of makeX(), then resolve x.foo(). caller directly calls
// makeX and X::foo; construction inside makeX belongs only to makeX, not caller. The empty Y::foo
// group guards against name-only binding.
#[tokio::test]
async fn cpp_auto_factory_return_receiver() {
    let constructor = description("X::X", "auto.cc", 2, 2);
    let method = description("X::foo", "auto.cc", 3, 3);
    let other = description("Y::foo", "auto.cc", 6, 6);
    let factory = description("makeX", "auto.cc", 8, 10);
    let entry = description("caller", "auto.cc", 12, 15);
    check_case(Case {
        name: "cpp_auto_factory_return_receiver",
        files: vec![SourceFile {
            path: "auto.cc",
            source: r"struct X {
    X() {}
    void foo() {}
};
struct Y {
    void foo() {}
};
X makeX() {
    return X{};
}

void caller() {
    auto x = makeX();
    x.foo();
}
",
        }],
        queries: vec![
            Query {
                direction: "in",
                symbol: "foo",
                expected: vec![
                    relationships(&method, &[(&entry, 14, 6)]),
                    relationships(&other, &[]),
                ],
            },
            Query {
                direction: "out",
                symbol: "caller",
                expected: vec![relationships(
                    &entry,
                    &[(&factory, 13, 13), (&method, 14, 6)],
                )],
            },
            Query {
                direction: "out",
                symbol: "makeX",
                expected: vec![relationships(&factory, &[(&constructor, 9, 11)])],
            },
            Query {
                direction: "in",
                symbol: "Y::foo",
                expected: vec![relationships(&other, &[])],
            },
        ],
    })
    .await;
}

// zvec-grep-specific C++ auto receiver regression.
// Infer auto& x = existing as X& from the X& parameter. The reference binding is not a call and
// performs no construction. x.foo() must resolve to X::foo rather than Y::foo.
#[tokio::test]
async fn cpp_auto_reference_alias_receiver() {
    let method = description("X::foo", "auto.cc", 3, 3);
    let other = description("Y::foo", "auto.cc", 6, 6);
    let entry = description("caller", "auto.cc", 8, 11);
    check_case(Case {
        name: "cpp_auto_reference_alias_receiver",
        files: vec![SourceFile {
            path: "auto.cc",
            source: r"struct X {
    X() {}
    void foo() {}
};
struct Y {
    void foo() {}
};
void caller(X& existing) {
    auto& x = existing;
    x.foo();
}
",
        }],
        queries: vec![
            Query {
                direction: "in",
                symbol: "foo",
                expected: vec![
                    relationships(&method, &[(&entry, 10, 6)]),
                    relationships(&other, &[]),
                ],
            },
            Query {
                direction: "out",
                symbol: "caller",
                expected: vec![relationships(&entry, &[(&method, 10, 6)])],
            },
            Query {
                direction: "in",
                symbol: "Y::foo",
                expected: vec![relationships(&other, &[])],
            },
        ],
    })
    .await;
}

// zvec-grep-specific inferred receiver/callback regression.
// Java var uses the initializer type, the declared X factory return type, or a copied object
// reference. The explicit X constructor is a direct call only where new X() occurs. Copying x to y
// is not a call. Y::foo is deliberately present as a same-named decoy. Query only direct calls:
// construction inside the factory must not leak into caller.
#[tokio::test]
async fn java_inferred_creation_receiver() {
    let constructor = description("X::X", "Inferred.java", 2, 2);
    let method = description("X::foo", "Inferred.java", 3, 3);
    let other = description("Y::foo", "Inferred.java", 6, 6);
    let entry = description("Use::caller", "Inferred.java", 12, 15);
    check_case(Case {
        name: "java_inferred_creation_receiver",
        files: vec![SourceFile {
            path: "Inferred.java",
            source: r"class X {
    X() {}
    void foo() {}
}
class Y {
    void foo() {}
}
class Use {
    static X makeX() {
        return new X();
    }
    static void caller() {
        var x = new X();
        x.foo();
    }
}
",
        }],
        queries: vec![
            Query {
                direction: "in",
                symbol: "foo",
                expected: vec![
                    relationships(&method, &[(&entry, 14, 10)]),
                    relationships(&other, &[]),
                ],
            },
            Query {
                direction: "out",
                symbol: "Use::caller",
                expected: vec![relationships(
                    &entry,
                    &[(&constructor, 13, 20), (&method, 14, 10)],
                )],
            },
            Query {
                direction: "in",
                symbol: "Y::foo",
                expected: vec![relationships(&other, &[])],
            },
        ],
    })
    .await;
}

// zvec-grep-specific inferred receiver/callback regression.
// Java var uses the initializer type, the declared X factory return type, or a copied object
// reference. The explicit X constructor is a direct call only where new X() occurs. Copying x to y
// is not a call. Y::foo is deliberately present as a same-named decoy. Query only direct calls:
// construction inside the factory must not leak into caller.
#[tokio::test]
async fn java_inferred_factory_return_receiver() {
    let constructor = description("X::X", "Inferred.java", 2, 2);
    let method = description("X::foo", "Inferred.java", 3, 3);
    let other = description("Y::foo", "Inferred.java", 6, 6);
    let factory = description("Use::makeX", "Inferred.java", 9, 11);
    let entry = description("Use::caller", "Inferred.java", 12, 15);
    check_case(Case {
        name: "java_inferred_factory_return_receiver",
        files: vec![SourceFile {
            path: "Inferred.java",
            source: r"class X {
    X() {}
    void foo() {}
}
class Y {
    void foo() {}
}
class Use {
    static X makeX() {
        return new X();
    }
    static void caller() {
        var x = makeX();
        x.foo();
    }
}
",
        }],
        queries: vec![
            Query {
                direction: "in",
                symbol: "foo",
                expected: vec![
                    relationships(&method, &[(&entry, 14, 10)]),
                    relationships(&other, &[]),
                ],
            },
            Query {
                direction: "out",
                symbol: "Use::caller",
                expected: vec![relationships(
                    &entry,
                    &[(&factory, 13, 16), (&method, 14, 10)],
                )],
            },
            Query {
                direction: "in",
                symbol: "Y::foo",
                expected: vec![relationships(&other, &[])],
            },
            Query {
                direction: "out",
                symbol: "Use::makeX",
                expected: vec![relationships(&factory, &[(&constructor, 10, 19)])],
            },
        ],
    })
    .await;
}

// zvec-grep-specific inferred receiver/callback regression.
// Java var uses the initializer type, the declared X factory return type, or a copied object
// reference. The explicit X constructor is a direct call only where new X() occurs. Copying x to y
// is not a call. Y::foo is deliberately present as a same-named decoy. Query only direct calls:
// construction inside the factory must not leak into caller.
#[tokio::test]
async fn java_inferred_variable_alias_receiver() {
    let constructor = description("X::X", "Inferred.java", 2, 2);
    let method = description("X::foo", "Inferred.java", 3, 3);
    let other = description("Y::foo", "Inferred.java", 6, 6);
    let factory = description("Use::makeX", "Inferred.java", 9, 11);
    let entry = description("Use::caller", "Inferred.java", 12, 16);
    check_case(Case {
        name: "java_inferred_variable_alias_receiver",
        files: vec![SourceFile {
            path: "Inferred.java",
            source: r"class X {
    X() {}
    void foo() {}
}
class Y {
    void foo() {}
}
class Use {
    static X makeX() {
        return new X();
    }
    static void caller() {
        var x = makeX();
        var y = x;
        y.foo();
    }
}
",
        }],
        queries: vec![
            Query {
                direction: "in",
                symbol: "foo",
                expected: vec![
                    relationships(&method, &[(&entry, 15, 10)]),
                    relationships(&other, &[]),
                ],
            },
            Query {
                direction: "out",
                symbol: "Use::caller",
                expected: vec![relationships(
                    &entry,
                    &[(&factory, 13, 16), (&method, 15, 10)],
                )],
            },
            Query {
                direction: "in",
                symbol: "Y::foo",
                expected: vec![relationships(&other, &[])],
            },
            Query {
                direction: "out",
                symbol: "Use::makeX",
                expected: vec![relationships(&factory, &[(&constructor, 10, 19)])],
            },
        ],
    })
    .await;
}

// zvec-grep-specific inferred receiver/callback regression.
// JavaScript infers the receiver from new X(), factory return expressions and reference aliases.
// As in the existing implicit-constructor contract, new X() targets the X class definition;
// copying x to y creates no call. Y::foo is deliberately present as a same-named decoy. Query only
// direct calls: construction inside the factory must not leak into caller.
#[tokio::test]
async fn javascript_inferred_creation_receiver() {
    let constructor = description("X", "inferred.js", 1, 3);
    let method = description("X::foo", "inferred.js", 2, 2);
    let other = description("Y::foo", "inferred.js", 5, 5);
    let entry = description("caller", "inferred.js", 10, 13);
    check_case(Case {
        name: "javascript_inferred_creation_receiver",
        files: vec![SourceFile {
            path: "inferred.js",
            source: r"class X {
    foo() {}
}
class Y {
    foo() {}
}
function makeX() {
    return new X();
}
function caller() {
    const x = new X();
    x.foo();
}
",
        }],
        queries: vec![
            Query {
                direction: "in",
                symbol: "foo",
                expected: vec![
                    relationships(&method, &[(&entry, 12, 6)]),
                    relationships(&other, &[]),
                ],
            },
            Query {
                direction: "out",
                symbol: "caller",
                expected: vec![relationships(
                    &entry,
                    &[(&constructor, 11, 18), (&method, 12, 6)],
                )],
            },
            Query {
                direction: "in",
                symbol: "Y::foo",
                expected: vec![relationships(&other, &[])],
            },
        ],
    })
    .await;
}

// zvec-grep-specific inferred receiver/callback regression.
// JavaScript infers the receiver from new X(), factory return expressions and reference aliases.
// As in the existing implicit-constructor contract, new X() targets the X class definition;
// copying x to y creates no call. Y::foo is deliberately present as a same-named decoy. Query only
// direct calls: construction inside the factory must not leak into caller.
#[tokio::test]
async fn javascript_inferred_factory_return_receiver() {
    let constructor = description("X", "inferred.js", 1, 3);
    let method = description("X::foo", "inferred.js", 2, 2);
    let other = description("Y::foo", "inferred.js", 5, 5);
    let factory = description("makeX", "inferred.js", 7, 9);
    let entry = description("caller", "inferred.js", 10, 13);
    check_case(Case {
        name: "javascript_inferred_factory_return_receiver",
        files: vec![SourceFile {
            path: "inferred.js",
            source: r"class X {
    foo() {}
}
class Y {
    foo() {}
}
function makeX() {
    return new X();
}
function caller() {
    const x = makeX();
    x.foo();
}
",
        }],
        queries: vec![
            Query {
                direction: "in",
                symbol: "foo",
                expected: vec![
                    relationships(&method, &[(&entry, 12, 6)]),
                    relationships(&other, &[]),
                ],
            },
            Query {
                direction: "out",
                symbol: "caller",
                expected: vec![relationships(
                    &entry,
                    &[(&factory, 11, 14), (&method, 12, 6)],
                )],
            },
            Query {
                direction: "in",
                symbol: "Y::foo",
                expected: vec![relationships(&other, &[])],
            },
            Query {
                direction: "out",
                symbol: "makeX",
                expected: vec![relationships(&factory, &[(&constructor, 8, 15)])],
            },
        ],
    })
    .await;
}

// zvec-grep-specific inferred receiver/callback regression.
// JavaScript infers the receiver from new X(), factory return expressions and reference aliases.
// As in the existing implicit-constructor contract, new X() targets the X class definition;
// copying x to y creates no call. Y::foo is deliberately present as a same-named decoy. Query only
// direct calls: construction inside the factory must not leak into caller.
#[tokio::test]
async fn javascript_inferred_variable_alias_receiver() {
    let constructor = description("X", "inferred.js", 1, 3);
    let method = description("X::foo", "inferred.js", 2, 2);
    let other = description("Y::foo", "inferred.js", 5, 5);
    let factory = description("makeX", "inferred.js", 7, 9);
    let entry = description("caller", "inferred.js", 10, 14);
    check_case(Case {
        name: "javascript_inferred_variable_alias_receiver",
        files: vec![SourceFile {
            path: "inferred.js",
            source: r"class X {
    foo() {}
}
class Y {
    foo() {}
}
function makeX() {
    return new X();
}
function caller() {
    const x = makeX();
    const y = x;
    y.foo();
}
",
        }],
        queries: vec![
            Query {
                direction: "in",
                symbol: "foo",
                expected: vec![
                    relationships(&method, &[(&entry, 13, 6)]),
                    relationships(&other, &[]),
                ],
            },
            Query {
                direction: "out",
                symbol: "caller",
                expected: vec![relationships(
                    &entry,
                    &[(&factory, 11, 14), (&method, 13, 6)],
                )],
            },
            Query {
                direction: "in",
                symbol: "Y::foo",
                expected: vec![relationships(&other, &[])],
            },
            Query {
                direction: "out",
                symbol: "makeX",
                expected: vec![relationships(&factory, &[(&constructor, 8, 15)])],
            },
        ],
    })
    .await;
}

// zvec-grep-specific inferred receiver/callback regression.
// TypeScript infers the receiver from new X(), the declared factory return type and reference
// aliases. As in the existing implicit-constructor contract, new X() targets the X class
// definition; copying x to y creates no call. Y::foo is deliberately present as a same-named
// decoy. Query only direct calls: construction inside the factory must not leak into caller.
#[tokio::test]
async fn typescript_inferred_creation_receiver() {
    let constructor = description("X", "inferred.ts", 1, 3);
    let method = description("X::foo", "inferred.ts", 2, 2);
    let other = description("Y::foo", "inferred.ts", 5, 5);
    let entry = description("caller", "inferred.ts", 10, 13);
    check_case(Case {
        name: "typescript_inferred_creation_receiver",
        files: vec![SourceFile {
            path: "inferred.ts",
            source: r"class X {
    foo() {}
}
class Y {
    foo() {}
}
function makeX(): X {
    return new X();
}
function caller() {
    const x = new X();
    x.foo();
}
",
        }],
        queries: vec![
            Query {
                direction: "in",
                symbol: "foo",
                expected: vec![
                    relationships(&method, &[(&entry, 12, 6)]),
                    relationships(&other, &[]),
                ],
            },
            Query {
                direction: "out",
                symbol: "caller",
                expected: vec![relationships(
                    &entry,
                    &[(&constructor, 11, 18), (&method, 12, 6)],
                )],
            },
            Query {
                direction: "in",
                symbol: "Y::foo",
                expected: vec![relationships(&other, &[])],
            },
        ],
    })
    .await;
}

// zvec-grep-specific inferred receiver/callback regression.
// TypeScript infers the receiver from new X(), the declared factory return type and reference
// aliases. As in the existing implicit-constructor contract, new X() targets the X class
// definition; copying x to y creates no call. Y::foo is deliberately present as a same-named
// decoy. Query only direct calls: construction inside the factory must not leak into caller.
#[tokio::test]
async fn typescript_inferred_factory_return_receiver() {
    let constructor = description("X", "inferred.ts", 1, 3);
    let method = description("X::foo", "inferred.ts", 2, 2);
    let other = description("Y::foo", "inferred.ts", 5, 5);
    let factory = description("makeX", "inferred.ts", 7, 9);
    let entry = description("caller", "inferred.ts", 10, 13);
    check_case(Case {
        name: "typescript_inferred_factory_return_receiver",
        files: vec![SourceFile {
            path: "inferred.ts",
            source: r"class X {
    foo() {}
}
class Y {
    foo() {}
}
function makeX(): X {
    return new X();
}
function caller() {
    const x = makeX();
    x.foo();
}
",
        }],
        queries: vec![
            Query {
                direction: "in",
                symbol: "foo",
                expected: vec![
                    relationships(&method, &[(&entry, 12, 6)]),
                    relationships(&other, &[]),
                ],
            },
            Query {
                direction: "out",
                symbol: "caller",
                expected: vec![relationships(
                    &entry,
                    &[(&factory, 11, 14), (&method, 12, 6)],
                )],
            },
            Query {
                direction: "in",
                symbol: "Y::foo",
                expected: vec![relationships(&other, &[])],
            },
            Query {
                direction: "out",
                symbol: "makeX",
                expected: vec![relationships(&factory, &[(&constructor, 8, 15)])],
            },
        ],
    })
    .await;
}

// zvec-grep-specific inferred receiver/callback regression.
// TypeScript infers the receiver from new X(), the declared factory return type and reference
// aliases. As in the existing implicit-constructor contract, new X() targets the X class
// definition; copying x to y creates no call. Y::foo is deliberately present as a same-named
// decoy. Query only direct calls: construction inside the factory must not leak into caller.
#[tokio::test]
async fn typescript_inferred_variable_alias_receiver() {
    let constructor = description("X", "inferred.ts", 1, 3);
    let method = description("X::foo", "inferred.ts", 2, 2);
    let other = description("Y::foo", "inferred.ts", 5, 5);
    let factory = description("makeX", "inferred.ts", 7, 9);
    let entry = description("caller", "inferred.ts", 10, 14);
    check_case(Case {
        name: "typescript_inferred_variable_alias_receiver",
        files: vec![SourceFile {
            path: "inferred.ts",
            source: r"class X {
    foo() {}
}
class Y {
    foo() {}
}
function makeX(): X {
    return new X();
}
function caller() {
    const x = makeX();
    const y = x;
    y.foo();
}
",
        }],
        queries: vec![
            Query {
                direction: "in",
                symbol: "foo",
                expected: vec![
                    relationships(&method, &[(&entry, 13, 6)]),
                    relationships(&other, &[]),
                ],
            },
            Query {
                direction: "out",
                symbol: "caller",
                expected: vec![relationships(
                    &entry,
                    &[(&factory, 11, 14), (&method, 13, 6)],
                )],
            },
            Query {
                direction: "in",
                symbol: "Y::foo",
                expected: vec![relationships(&other, &[])],
            },
            Query {
                direction: "out",
                symbol: "makeX",
                expected: vec![relationships(&factory, &[(&constructor, 8, 15)])],
            },
        ],
    })
    .await;
}

// zvec-grep-specific inferred receiver/callback regression.
// Python infers the receiver from X(), the unannotated factory return expression and a local
// variable alias. X has no explicit __init__; construction targets the class definition rather
// than fabricating an initializer entity. Bare assignment is not a call. Y::foo is deliberately
// present as a same-named decoy. Query only direct calls: construction inside the factory must not
// leak into caller.
#[tokio::test]
async fn python_inferred_creation_receiver() {
    let constructor = description("X", "inferred.py", 1, 3);
    let method = description("X::foo", "inferred.py", 2, 3);
    let other = description("Y::foo", "inferred.py", 5, 6);
    let entry = description("caller", "inferred.py", 11, 13);
    check_case(Case {
        name: "python_inferred_creation_receiver",
        files: vec![SourceFile {
            path: "inferred.py",
            source: r"class X:
    def foo(self):
        pass
class Y:
    def foo(self):
        pass

def make_x():
    return X()

def caller():
    x = X()
    x.foo()
",
        }],
        queries: vec![
            Query {
                direction: "in",
                symbol: "foo",
                expected: vec![
                    relationships(&method, &[(&entry, 13, 6)]),
                    relationships(&other, &[]),
                ],
            },
            Query {
                direction: "out",
                symbol: "caller",
                expected: vec![relationships(
                    &entry,
                    &[(&constructor, 12, 8), (&method, 13, 6)],
                )],
            },
            Query {
                direction: "in",
                symbol: "Y::foo",
                expected: vec![relationships(&other, &[])],
            },
        ],
    })
    .await;
}

// zvec-grep-specific inferred receiver/callback regression.
// Python infers the receiver from X(), the unannotated factory return expression and a local
// variable alias. X has no explicit __init__; construction targets the class definition rather
// than fabricating an initializer entity. Bare assignment is not a call. Y::foo is deliberately
// present as a same-named decoy. Query only direct calls: construction inside the factory must not
// leak into caller.
#[tokio::test]
async fn python_inferred_factory_return_receiver() {
    let constructor = description("X", "inferred.py", 1, 3);
    let method = description("X::foo", "inferred.py", 2, 3);
    let other = description("Y::foo", "inferred.py", 5, 6);
    let factory = description("make_x", "inferred.py", 8, 9);
    let entry = description("caller", "inferred.py", 11, 13);
    check_case(Case {
        name: "python_inferred_factory_return_receiver",
        files: vec![SourceFile {
            path: "inferred.py",
            source: r"class X:
    def foo(self):
        pass
class Y:
    def foo(self):
        pass

def make_x():
    return X()

def caller():
    x = make_x()
    x.foo()
",
        }],
        queries: vec![
            Query {
                direction: "in",
                symbol: "foo",
                expected: vec![
                    relationships(&method, &[(&entry, 13, 6)]),
                    relationships(&other, &[]),
                ],
            },
            Query {
                direction: "out",
                symbol: "caller",
                expected: vec![relationships(
                    &entry,
                    &[(&factory, 12, 8), (&method, 13, 6)],
                )],
            },
            Query {
                direction: "in",
                symbol: "Y::foo",
                expected: vec![relationships(&other, &[])],
            },
            Query {
                direction: "out",
                symbol: "make_x",
                expected: vec![relationships(&factory, &[(&constructor, 9, 11)])],
            },
        ],
    })
    .await;
}

// zvec-grep-specific inferred receiver/callback regression.
// Python infers the receiver from X(), the unannotated factory return expression and a local
// variable alias. X has no explicit __init__; construction targets the class definition rather
// than fabricating an initializer entity. Bare assignment is not a call. Y::foo is deliberately
// present as a same-named decoy. Query only direct calls: construction inside the factory must not
// leak into caller.
#[tokio::test]
async fn python_inferred_variable_alias_receiver() {
    let constructor = description("X", "inferred.py", 1, 3);
    let method = description("X::foo", "inferred.py", 2, 3);
    let other = description("Y::foo", "inferred.py", 5, 6);
    let factory = description("make_x", "inferred.py", 8, 9);
    let entry = description("caller", "inferred.py", 11, 14);
    check_case(Case {
        name: "python_inferred_variable_alias_receiver",
        files: vec![SourceFile {
            path: "inferred.py",
            source: r"class X:
    def foo(self):
        pass
class Y:
    def foo(self):
        pass

def make_x():
    return X()

def caller():
    x = make_x()
    y = x
    y.foo()
",
        }],
        queries: vec![
            Query {
                direction: "in",
                symbol: "foo",
                expected: vec![
                    relationships(&method, &[(&entry, 14, 6)]),
                    relationships(&other, &[]),
                ],
            },
            Query {
                direction: "out",
                symbol: "caller",
                expected: vec![relationships(
                    &entry,
                    &[(&factory, 12, 8), (&method, 14, 6)],
                )],
            },
            Query {
                direction: "in",
                symbol: "Y::foo",
                expected: vec![relationships(&other, &[])],
            },
            Query {
                direction: "out",
                symbol: "make_x",
                expected: vec![relationships(&factory, &[(&constructor, 9, 11)])],
            },
        ],
    })
    .await;
}

// zvec-grep-specific inferred receiver/callback regression.
// Go short declarations infer *X from new(X) or the factory signature; y := x copies that pointer.
// Builtin new has no indexed function target and is not a fabricated constructor call. Pointer-
// receiver foo must bind to X, not Y. Y::foo is deliberately present as a same-named decoy. Query
// only direct calls: construction inside the factory must not leak into caller.
#[tokio::test]
async fn go_inferred_creation_receiver() {
    let method = description("X::foo", "inferred.go", 4, 4);
    let other = description("Y::foo", "inferred.go", 6, 6);
    let entry = description("caller", "inferred.go", 10, 13);
    check_case(Case {
        name: "go_inferred_creation_receiver",
        files: vec![SourceFile {
            path: "inferred.go",
            source: r"package inferred

type X struct{}
func (x *X) foo() {}
type Y struct{}
func (y *Y) foo() {}
func makeX() *X {
    return new(X)
}
func caller() {
    x := new(X)
    x.foo()
}
",
        }],
        queries: vec![
            Query {
                direction: "in",
                symbol: "foo",
                expected: vec![
                    relationships(&method, &[(&entry, 12, 6)]),
                    relationships(&other, &[]),
                ],
            },
            Query {
                direction: "out",
                symbol: "caller",
                expected: vec![relationships(&entry, &[(&method, 12, 6)])],
            },
            Query {
                direction: "in",
                symbol: "Y::foo",
                expected: vec![relationships(&other, &[])],
            },
        ],
    })
    .await;
}

// zvec-grep-specific inferred receiver/callback regression.
// Go short declarations infer *X from new(X) or the factory signature; y := x copies that pointer.
// Builtin new has no indexed function target and is not a fabricated constructor call. Pointer-
// receiver foo must bind to X, not Y. Y::foo is deliberately present as a same-named decoy. Query
// only direct calls: construction inside the factory must not leak into caller.
#[tokio::test]
async fn go_inferred_factory_return_receiver() {
    let method = description("X::foo", "inferred.go", 4, 4);
    let other = description("Y::foo", "inferred.go", 6, 6);
    let factory = description("makeX", "inferred.go", 7, 9);
    let entry = description("caller", "inferred.go", 10, 13);
    check_case(Case {
        name: "go_inferred_factory_return_receiver",
        files: vec![SourceFile {
            path: "inferred.go",
            source: r"package inferred

type X struct{}
func (x *X) foo() {}
type Y struct{}
func (y *Y) foo() {}
func makeX() *X {
    return new(X)
}
func caller() {
    x := makeX()
    x.foo()
}
",
        }],
        queries: vec![
            Query {
                direction: "in",
                symbol: "foo",
                expected: vec![
                    relationships(&method, &[(&entry, 12, 6)]),
                    relationships(&other, &[]),
                ],
            },
            Query {
                direction: "out",
                symbol: "caller",
                expected: vec![relationships(
                    &entry,
                    &[(&factory, 11, 9), (&method, 12, 6)],
                )],
            },
            Query {
                direction: "in",
                symbol: "Y::foo",
                expected: vec![relationships(&other, &[])],
            },
            Query {
                direction: "out",
                symbol: "makeX",
                expected: vec![relationships(&factory, &[])],
            },
        ],
    })
    .await;
}

// zvec-grep-specific inferred receiver/callback regression.
// Go short declarations infer *X from new(X) or the factory signature; y := x copies that pointer.
// Builtin new has no indexed function target and is not a fabricated constructor call. Pointer-
// receiver foo must bind to X, not Y. Y::foo is deliberately present as a same-named decoy. Query
// only direct calls: construction inside the factory must not leak into caller.
#[tokio::test]
async fn go_inferred_variable_alias_receiver() {
    let method = description("X::foo", "inferred.go", 4, 4);
    let other = description("Y::foo", "inferred.go", 6, 6);
    let factory = description("makeX", "inferred.go", 7, 9);
    let entry = description("caller", "inferred.go", 10, 14);
    check_case(Case {
        name: "go_inferred_variable_alias_receiver",
        files: vec![SourceFile {
            path: "inferred.go",
            source: r"package inferred

type X struct{}
func (x *X) foo() {}
type Y struct{}
func (y *Y) foo() {}
func makeX() *X {
    return new(X)
}
func caller() {
    x := makeX()
    y := x
    y.foo()
}
",
        }],
        queries: vec![
            Query {
                direction: "in",
                symbol: "foo",
                expected: vec![
                    relationships(&method, &[(&entry, 13, 6)]),
                    relationships(&other, &[]),
                ],
            },
            Query {
                direction: "out",
                symbol: "caller",
                expected: vec![relationships(
                    &entry,
                    &[(&factory, 11, 9), (&method, 13, 6)],
                )],
            },
            Query {
                direction: "in",
                symbol: "Y::foo",
                expected: vec![relationships(&other, &[])],
            },
            Query {
                direction: "out",
                symbol: "makeX",
                expected: vec![relationships(&factory, &[])],
            },
        ],
    })
    .await;
}

// zvec-grep-specific inferred receiver/callback regression.
// Rust let bindings infer X from a struct expression or the factory signature. let y = x moves the
// value without creating a call; y.foo() still binds to X. The X {} struct expression is not a
// constructor function call. Y::foo is deliberately present as a same-named decoy. Query only
// direct calls: construction inside the factory must not leak into caller.
#[tokio::test]
async fn rust_inferred_creation_receiver() {
    let method = description("X::foo", "inferred.rs", 3, 3);
    let other = description("Y::foo", "inferred.rs", 7, 7);
    let entry = description("caller", "inferred.rs", 12, 15);
    check_case(Case {
        name: "rust_inferred_creation_receiver",
        files: vec![SourceFile {
            path: "inferred.rs",
            source: r"struct X {}
impl X {
    fn foo(&self) {}
}
struct Y {}
impl Y {
    fn foo(&self) {}
}
fn make_x() -> X {
    X {}
}
fn caller() {
    let x = X {};
    x.foo();
}
",
        }],
        queries: vec![
            Query {
                direction: "in",
                symbol: "foo",
                expected: vec![
                    relationships(&method, &[(&entry, 14, 6)]),
                    relationships(&other, &[]),
                ],
            },
            Query {
                direction: "out",
                symbol: "caller",
                expected: vec![relationships(&entry, &[(&method, 14, 6)])],
            },
            Query {
                direction: "in",
                symbol: "Y::foo",
                expected: vec![relationships(&other, &[])],
            },
        ],
    })
    .await;
}

// zvec-grep-specific inferred receiver/callback regression.
// Rust let bindings infer X from a struct expression or the factory signature. let y = x moves the
// value without creating a call; y.foo() still binds to X. The X {} struct expression is not a
// constructor function call. Y::foo is deliberately present as a same-named decoy. Query only
// direct calls: construction inside the factory must not leak into caller.
#[tokio::test]
async fn rust_inferred_factory_return_receiver() {
    let method = description("X::foo", "inferred.rs", 3, 3);
    let other = description("Y::foo", "inferred.rs", 7, 7);
    let factory = description("make_x", "inferred.rs", 9, 11);
    let entry = description("caller", "inferred.rs", 12, 15);
    check_case(Case {
        name: "rust_inferred_factory_return_receiver",
        files: vec![SourceFile {
            path: "inferred.rs",
            source: r"struct X {}
impl X {
    fn foo(&self) {}
}
struct Y {}
impl Y {
    fn foo(&self) {}
}
fn make_x() -> X {
    X {}
}
fn caller() {
    let x = make_x();
    x.foo();
}
",
        }],
        queries: vec![
            Query {
                direction: "in",
                symbol: "foo",
                expected: vec![
                    relationships(&method, &[(&entry, 14, 6)]),
                    relationships(&other, &[]),
                ],
            },
            Query {
                direction: "out",
                symbol: "caller",
                expected: vec![relationships(
                    &entry,
                    &[(&factory, 13, 12), (&method, 14, 6)],
                )],
            },
            Query {
                direction: "in",
                symbol: "Y::foo",
                expected: vec![relationships(&other, &[])],
            },
            Query {
                direction: "out",
                symbol: "make_x",
                expected: vec![relationships(&factory, &[])],
            },
        ],
    })
    .await;
}

// zvec-grep-specific inferred receiver/callback regression.
// Rust let bindings infer X from a struct expression or the factory signature. let y = x moves the
// value without creating a call; y.foo() still binds to X. The X {} struct expression is not a
// constructor function call. Y::foo is deliberately present as a same-named decoy. Query only
// direct calls: construction inside the factory must not leak into caller.
#[tokio::test]
async fn rust_inferred_variable_alias_receiver() {
    let method = description("X::foo", "inferred.rs", 3, 3);
    let other = description("Y::foo", "inferred.rs", 7, 7);
    let factory = description("make_x", "inferred.rs", 9, 11);
    let entry = description("caller", "inferred.rs", 12, 16);
    check_case(Case {
        name: "rust_inferred_variable_alias_receiver",
        files: vec![SourceFile {
            path: "inferred.rs",
            source: r"struct X {}
impl X {
    fn foo(&self) {}
}
struct Y {}
impl Y {
    fn foo(&self) {}
}
fn make_x() -> X {
    X {}
}
fn caller() {
    let x = make_x();
    let y = x;
    y.foo();
}
",
        }],
        queries: vec![
            Query {
                direction: "in",
                symbol: "foo",
                expected: vec![
                    relationships(&method, &[(&entry, 15, 6)]),
                    relationships(&other, &[]),
                ],
            },
            Query {
                direction: "out",
                symbol: "caller",
                expected: vec![relationships(
                    &entry,
                    &[(&factory, 13, 12), (&method, 15, 6)],
                )],
            },
            Query {
                direction: "in",
                symbol: "Y::foo",
                expected: vec![relationships(&other, &[])],
            },
            Query {
                direction: "out",
                symbol: "make_x",
                expected: vec![relationships(&factory, &[])],
            },
        ],
    })
    .await;
}

// zvec-grep-specific inferred receiver/callback regression.
// C callback regression: makeX and makeY return different same-named static targets from x.c and
// y.c. The factory returns a function pointer value, which x() invokes. Returning the function
// name is not a call.
#[tokio::test]
async fn c_inferred_factory_function_pointer() {
    let target = description("foo", "x.c", 2, 2);
    let other = description("foo", "y.c", 2, 2);
    let factory = description("makeX", "x.c", 3, 5);
    let entry = description("caller", "caller.c", 2, 5);
    check_case(Case {
        name: "c_inferred_factory_function_pointer",
        files: vec![
            SourceFile {
                path: "callback.h",
                source: r"typedef void (*Callback)(void);
Callback makeX(void);
Callback makeY(void);
",
            },
            SourceFile {
                path: "x.c",
                source: r#"#include "callback.h"
static void foo(void) {}
Callback makeX(void) {
    return foo;
}
"#,
            },
            SourceFile {
                path: "y.c",
                source: r#"#include "callback.h"
static void foo(void) {}
Callback makeY(void) {
    return foo;
}
"#,
            },
            SourceFile {
                path: "caller.c",
                source: r#"#include "callback.h"
void caller(void) {
    Callback x = makeX();
    x();
}
"#,
            },
        ],
        queries: vec![
            Query {
                direction: "in",
                symbol: "foo",
                expected: vec![
                    relationships(&target, &[(&entry, 4, 4)]),
                    relationships(&other, &[]),
                ],
            },
            Query {
                direction: "out",
                symbol: "caller",
                expected: vec![relationships(&entry, &[(&factory, 3, 17), (&target, 4, 4)])],
            },
            Query {
                direction: "out",
                symbol: "makeX",
                expected: vec![relationships(&factory, &[])],
            },
        ],
    })
    .await;
}

// zvec-grep-specific inferred receiver/callback regression.
// C callback regression: makeX and makeY return different same-named static targets from x.c and
// y.c. Copying a known function pointer to y preserves its target; assignment itself is not a
// call.
#[tokio::test]
async fn c_inferred_function_pointer_alias() {
    let target = description("foo", "x.c", 2, 2);
    let other = description("foo", "y.c", 2, 2);
    let factory = description("makeX", "x.c", 3, 5);
    let entry = description("caller", "caller.c", 2, 6);
    check_case(Case {
        name: "c_inferred_function_pointer_alias",
        files: vec![
            SourceFile {
                path: "callback.h",
                source: r"typedef void (*Callback)(void);
Callback makeX(void);
Callback makeY(void);
",
            },
            SourceFile {
                path: "x.c",
                source: r#"#include "callback.h"
static void foo(void) {}
Callback makeX(void) {
    return foo;
}
"#,
            },
            SourceFile {
                path: "y.c",
                source: r#"#include "callback.h"
static void foo(void) {}
Callback makeY(void) {
    return foo;
}
"#,
            },
            SourceFile {
                path: "caller.c",
                source: r#"#include "callback.h"
void caller(void) {
    Callback x = makeX();
    Callback y = x;
    y();
}
"#,
            },
        ],
        queries: vec![
            Query {
                direction: "in",
                symbol: "foo",
                expected: vec![
                    relationships(&target, &[(&entry, 5, 4)]),
                    relationships(&other, &[]),
                ],
            },
            Query {
                direction: "out",
                symbol: "caller",
                expected: vec![relationships(&entry, &[(&factory, 3, 17), (&target, 5, 4)])],
            },
            Query {
                direction: "out",
                symbol: "makeX",
                expected: vec![relationships(&factory, &[])],
            },
        ],
    })
    .await;
}

// zvec-grep-specific inferred receiver/callback regression.
// C callback regression: makeX and makeY return different same-named static targets from x.c and
// y.c. Follow a returned struct value to its foo function-pointer field; the field is not itself
// the called function. Both X and Y have foo fields.
#[tokio::test]
async fn c_inferred_struct_callback_member() {
    let target = description("run", "x.c", 2, 2);
    let other = description("run", "y.c", 2, 2);
    let factory = description("makeX", "x.c", 3, 5);
    let entry = description("caller", "caller.c", 2, 5);
    check_case(Case {
        name: "c_inferred_struct_callback_member",
        files: vec![
            SourceFile {
                path: "callback.h",
                source: r"typedef void (*Callback)(void);
struct X { Callback foo; };
struct Y { Callback foo; };
struct X makeX(void);
struct Y makeY(void);
",
            },
            SourceFile {
                path: "x.c",
                source: r#"#include "callback.h"
static void run(void) {}
struct X makeX(void) {
    return (struct X){ .foo = run };
}
"#,
            },
            SourceFile {
                path: "y.c",
                source: r#"#include "callback.h"
static void run(void) {}
struct Y makeY(void) {
    return (struct Y){ .foo = run };
}
"#,
            },
            SourceFile {
                path: "caller.c",
                source: r#"#include "callback.h"
void caller(void) {
    struct X x = makeX();
    x.foo();
}
"#,
            },
        ],
        queries: vec![
            Query {
                direction: "in",
                symbol: "run",
                expected: vec![
                    relationships(&target, &[(&entry, 4, 6)]),
                    relationships(&other, &[]),
                ],
            },
            Query {
                direction: "out",
                symbol: "caller",
                expected: vec![relationships(&entry, &[(&factory, 3, 17), (&target, 4, 6)])],
            },
            Query {
                direction: "out",
                symbol: "makeX",
                expected: vec![relationships(&factory, &[])],
            },
        ],
    })
    .await;
}

// zvec-grep-specific flow-sensitive receiver regression.
// Reassignment changes only subsequent x.foo() targets; earlier sites retain X.
#[tokio::test]
async fn javascript_receiver_reassignment() {
    let constructor_x = description("X", "reassigned.js", 1, 3);
    let method_x = description("X::foo", "reassigned.js", 2, 2);
    let constructor_y = description("Y", "reassigned.js", 4, 6);
    let method_y = description("Y::foo", "reassigned.js", 5, 5);
    let entry = description("caller", "reassigned.js", 7, 12);
    check_case(Case {
        name: "javascript_receiver_reassignment",
        files: vec![SourceFile {
            path: "reassigned.js",
            source: r"class X {
    foo() {}
}
class Y {
    foo() {}
}
function caller() {
    let x = new X();
    x.foo();
    x = new Y();
    x.foo();
}
",
        }],
        queries: vec![
            Query {
                direction: "in",
                symbol: "foo",
                expected: vec![
                    relationships(&method_x, &[(&entry, 9, 6)]),
                    relationships(&method_y, &[(&entry, 11, 6)]),
                ],
            },
            Query {
                direction: "in",
                symbol: "X::foo",
                expected: vec![relationships(&method_x, &[(&entry, 9, 6)])],
            },
            Query {
                direction: "in",
                symbol: "Y::foo",
                expected: vec![relationships(&method_y, &[(&entry, 11, 6)])],
            },
            Query {
                direction: "out",
                symbol: "caller",
                expected: vec![relationships(
                    &entry,
                    &[
                        (&constructor_x, 8, 16),
                        (&method_x, 9, 6),
                        (&constructor_y, 10, 12),
                        (&method_y, 11, 6),
                    ],
                )],
            },
        ],
    })
    .await;
}

// zvec-grep-specific flow-sensitive receiver regression.
// Reassignment changes only subsequent x.foo() targets; earlier sites retain X.
// y captures the X object before x is rebound to Y; y.foo() must still target X.
#[tokio::test]
async fn javascript_receiver_reassignment_preserves_alias() {
    let constructor_x = description("X", "reassigned.js", 1, 3);
    let method_x = description("X::foo", "reassigned.js", 2, 2);
    let constructor_y = description("Y", "reassigned.js", 4, 6);
    let method_y = description("Y::foo", "reassigned.js", 5, 5);
    let entry = description("caller", "reassigned.js", 7, 14);
    check_case(Case {
        name: "javascript_receiver_reassignment_preserves_alias",
        files: vec![SourceFile {
            path: "reassigned.js",
            source: r"class X {
    foo() {}
}
class Y {
    foo() {}
}
function caller() {
    let x = new X();
    x.foo();
    const y = x;
    x = new Y();
    x.foo();
    y.foo();
}
",
        }],
        queries: vec![
            Query {
                direction: "in",
                symbol: "foo",
                expected: vec![
                    relationships(&method_x, &[(&entry, 9, 6), (&entry, 13, 6)]),
                    relationships(&method_y, &[(&entry, 12, 6)]),
                ],
            },
            Query {
                direction: "in",
                symbol: "X::foo",
                expected: vec![relationships(&method_x, &[(&entry, 9, 6), (&entry, 13, 6)])],
            },
            Query {
                direction: "in",
                symbol: "Y::foo",
                expected: vec![relationships(&method_y, &[(&entry, 12, 6)])],
            },
            Query {
                direction: "out",
                symbol: "caller",
                expected: vec![relationships(
                    &entry,
                    &[
                        (&constructor_x, 8, 16),
                        (&method_x, 9, 6),
                        (&constructor_y, 11, 12),
                        (&method_y, 12, 6),
                        (&method_x, 13, 6),
                    ],
                )],
            },
        ],
    })
    .await;
}

// zvec-grep-specific flow-sensitive receiver regression.
// Reassignment changes only subsequent x.foo() targets; earlier sites retain X.
// The union permits both assignments; each straight-line call has one concrete receiver.
#[tokio::test]
async fn typescript_receiver_reassignment() {
    let constructor_x = description("X", "reassigned.ts", 1, 3);
    let method_x = description("X::foo", "reassigned.ts", 2, 2);
    let constructor_y = description("Y", "reassigned.ts", 4, 6);
    let method_y = description("Y::foo", "reassigned.ts", 5, 5);
    let entry = description("caller", "reassigned.ts", 7, 12);
    check_case(Case {
        name: "typescript_receiver_reassignment",
        files: vec![SourceFile {
            path: "reassigned.ts",
            source: r"class X {
    foo() {}
}
class Y {
    foo() {}
}
function caller() {
    let x: X | Y = new X();
    x.foo();
    x = new Y();
    x.foo();
}
",
        }],
        queries: vec![
            Query {
                direction: "in",
                symbol: "foo",
                expected: vec![
                    relationships(&method_x, &[(&entry, 9, 6)]),
                    relationships(&method_y, &[(&entry, 11, 6)]),
                ],
            },
            Query {
                direction: "in",
                symbol: "X::foo",
                expected: vec![relationships(&method_x, &[(&entry, 9, 6)])],
            },
            Query {
                direction: "in",
                symbol: "Y::foo",
                expected: vec![relationships(&method_y, &[(&entry, 11, 6)])],
            },
            Query {
                direction: "out",
                symbol: "caller",
                expected: vec![relationships(
                    &entry,
                    &[
                        (&constructor_x, 8, 23),
                        (&method_x, 9, 6),
                        (&constructor_y, 10, 12),
                        (&method_y, 11, 6),
                    ],
                )],
            },
        ],
    })
    .await;
}

// zvec-grep-specific flow-sensitive receiver regression.
// Reassignment changes only subsequent x.foo() targets; earlier sites retain X.
// y captures the X object before x is rebound to Y; y.foo() must still target X.
// The union permits both assignments; each straight-line call has one concrete receiver.
#[tokio::test]
async fn typescript_receiver_reassignment_preserves_alias() {
    let constructor_x = description("X", "reassigned.ts", 1, 3);
    let method_x = description("X::foo", "reassigned.ts", 2, 2);
    let constructor_y = description("Y", "reassigned.ts", 4, 6);
    let method_y = description("Y::foo", "reassigned.ts", 5, 5);
    let entry = description("caller", "reassigned.ts", 7, 14);
    check_case(Case {
        name: "typescript_receiver_reassignment_preserves_alias",
        files: vec![SourceFile {
            path: "reassigned.ts",
            source: r"class X {
    foo() {}
}
class Y {
    foo() {}
}
function caller() {
    let x: X | Y = new X();
    x.foo();
    const y = x;
    x = new Y();
    x.foo();
    y.foo();
}
",
        }],
        queries: vec![
            Query {
                direction: "in",
                symbol: "foo",
                expected: vec![
                    relationships(&method_x, &[(&entry, 9, 6), (&entry, 13, 6)]),
                    relationships(&method_y, &[(&entry, 12, 6)]),
                ],
            },
            Query {
                direction: "in",
                symbol: "X::foo",
                expected: vec![relationships(&method_x, &[(&entry, 9, 6), (&entry, 13, 6)])],
            },
            Query {
                direction: "in",
                symbol: "Y::foo",
                expected: vec![relationships(&method_y, &[(&entry, 12, 6)])],
            },
            Query {
                direction: "out",
                symbol: "caller",
                expected: vec![relationships(
                    &entry,
                    &[
                        (&constructor_x, 8, 23),
                        (&method_x, 9, 6),
                        (&constructor_y, 11, 12),
                        (&method_y, 12, 6),
                        (&method_x, 13, 6),
                    ],
                )],
            },
        ],
    })
    .await;
}

// zvec-grep-specific flow-sensitive receiver regression.
// Reassignment changes only subsequent x.foo() targets; earlier sites retain X.
#[tokio::test]
async fn python_receiver_reassignment() {
    let constructor_x = description("X", "reassigned.py", 1, 3);
    let method_x = description("X::foo", "reassigned.py", 2, 3);
    let constructor_y = description("Y", "reassigned.py", 4, 6);
    let method_y = description("Y::foo", "reassigned.py", 5, 6);
    let entry = description("caller", "reassigned.py", 8, 12);
    check_case(Case {
        name: "python_receiver_reassignment",
        files: vec![SourceFile {
            path: "reassigned.py",
            source: r"class X:
    def foo(self):
        pass
class Y:
    def foo(self):
        pass

def caller():
    x = X()
    x.foo()
    x = Y()
    x.foo()
",
        }],
        queries: vec![
            Query {
                direction: "in",
                symbol: "foo",
                expected: vec![
                    relationships(&method_x, &[(&entry, 10, 6)]),
                    relationships(&method_y, &[(&entry, 12, 6)]),
                ],
            },
            Query {
                direction: "in",
                symbol: "X::foo",
                expected: vec![relationships(&method_x, &[(&entry, 10, 6)])],
            },
            Query {
                direction: "in",
                symbol: "Y::foo",
                expected: vec![relationships(&method_y, &[(&entry, 12, 6)])],
            },
            Query {
                direction: "out",
                symbol: "caller",
                expected: vec![relationships(
                    &entry,
                    &[
                        (&constructor_x, 9, 8),
                        (&method_x, 10, 6),
                        (&constructor_y, 11, 8),
                        (&method_y, 12, 6),
                    ],
                )],
            },
        ],
    })
    .await;
}

// zvec-grep-specific flow-sensitive receiver regression.
// Reassignment changes only subsequent x.foo() targets; earlier sites retain X.
// y captures the X object before x is rebound to Y; y.foo() must still target X.
#[tokio::test]
async fn python_receiver_reassignment_preserves_alias() {
    let constructor_x = description("X", "reassigned.py", 1, 3);
    let method_x = description("X::foo", "reassigned.py", 2, 3);
    let constructor_y = description("Y", "reassigned.py", 4, 6);
    let method_y = description("Y::foo", "reassigned.py", 5, 6);
    let entry = description("caller", "reassigned.py", 8, 14);
    check_case(Case {
        name: "python_receiver_reassignment_preserves_alias",
        files: vec![SourceFile {
            path: "reassigned.py",
            source: r"class X:
    def foo(self):
        pass
class Y:
    def foo(self):
        pass

def caller():
    x = X()
    x.foo()
    y = x
    x = Y()
    x.foo()
    y.foo()
",
        }],
        queries: vec![
            Query {
                direction: "in",
                symbol: "foo",
                expected: vec![
                    relationships(&method_x, &[(&entry, 10, 6), (&entry, 14, 6)]),
                    relationships(&method_y, &[(&entry, 13, 6)]),
                ],
            },
            Query {
                direction: "in",
                symbol: "X::foo",
                expected: vec![relationships(
                    &method_x,
                    &[(&entry, 10, 6), (&entry, 14, 6)],
                )],
            },
            Query {
                direction: "in",
                symbol: "Y::foo",
                expected: vec![relationships(&method_y, &[(&entry, 13, 6)])],
            },
            Query {
                direction: "out",
                symbol: "caller",
                expected: vec![relationships(
                    &entry,
                    &[
                        (&constructor_x, 9, 8),
                        (&method_x, 10, 6),
                        (&constructor_y, 12, 8),
                        (&method_y, 13, 6),
                        (&method_x, 14, 6),
                    ],
                )],
            },
        ],
    })
    .await;
}

// https://github.com/microsoft/TypeScript/blob/fed0bf24149fb1ed36039212648bafdafc1ea10e/tsc/internal/fourslash/tests/callHierarchyExportDefaultFunction_test.go
// Upstream ExportDefaultFunction baseline: the anonymous export is named "default", not its
// import alias "bar". Strip the cursor marker and retain source lines. Reverse queries supplement
// the upstream incoming/outgoing checks; foo calls default directly, not its transitive callee baz.
#[tokio::test]
async fn typescript_lsp_default_export_call_hierarchy() {
    let target = description("default", "other.ts", 1, 3);
    let entry = description("foo", "main.ts", 3, 5);
    let leaf = description("baz", "other.ts", 5, 6);
    check_case(Case {
        name: "typescript_lsp_default_export_call_hierarchy",
        files: vec![
            SourceFile {
                path: "main.ts",
                source: r#"import bar from "./other";

function foo() {
    bar();
}
"#,
            },
            SourceFile {
                path: "other.ts",
                source: r"export default function () {
    baz();
}

function baz() {
}
",
            },
        ],
        queries: vec![
            Query {
                direction: "in",
                symbol: "default",
                expected: vec![relationships(&target, &[(&entry, 4, 4)])],
            },
            Query {
                direction: "out",
                symbol: "default",
                expected: vec![relationships(&target, &[(&leaf, 2, 4)])],
            },
            Query {
                direction: "out",
                symbol: "foo",
                expected: vec![relationships(&entry, &[(&target, 4, 4)])],
            },
            Query {
                direction: "in",
                symbol: "baz",
                expected: vec![relationships(&leaf, &[(&target, 2, 4)])],
            },
        ],
    })
    .await;
}

// https://github.com/microsoft/TypeScript/blob/fed0bf24149fb1ed36039212648bafdafc1ea10e/tsc/internal/fourslash/tests/callHierarchyTaggedTemplate_test.go
// Upstream TaggedTemplate baseline: bar`...` invokes bar without parentheses. Strip the cursor
// marker and retain source lines. Query both directions of the two direct calls; the literal
// interpolation creates no call, and baz belongs to bar rather than foo.
#[tokio::test]
async fn typescript_lsp_tagged_template_call_hierarchy() {
    let entry = description("foo", "tagged.ts", 1, 3);
    let target = description("bar", "tagged.ts", 5, 7);
    let leaf = description("baz", "tagged.ts", 9, 10);
    check_case(Case {
        name: "typescript_lsp_tagged_template_call_hierarchy",
        files: vec![SourceFile {
            path: "tagged.ts",
            source: r"function foo() {
    bar`a${1}b`;
}

function bar(array: TemplateStringsArray, ...args: any[]) {
    baz();
}

function baz() {
}
",
        }],
        queries: vec![
            Query {
                direction: "in",
                symbol: "bar",
                expected: vec![relationships(&target, &[(&entry, 2, 4)])],
            },
            Query {
                direction: "out",
                symbol: "bar",
                expected: vec![relationships(&target, &[(&leaf, 6, 4)])],
            },
            Query {
                direction: "out",
                symbol: "foo",
                expected: vec![relationships(&entry, &[(&target, 2, 4)])],
            },
            Query {
                direction: "in",
                symbol: "baz",
                expected: vec![relationships(&leaf, &[(&target, 6, 4)])],
            },
        ],
    })
    .await;
}

// https://github.com/rust-lang/rust-analyzer/blob/3131751eaf1c3b5da6e618acdc2148ad7db65bc7/crates/ide/src/call_hierarchy.rs
// Upstream test_trait_method_call_hierarchy: querying the trait declaration includes a caller
// invoking its concrete implementation. Strip the cursor marker and leading blank line. Preserve
// the upstream empty outgoing result for the bodyless trait method; the fixture does not specify
// caller's outgoing targets, so it does not require an invented duplicate edge to the declaration.
#[tokio::test]
async fn rust_lsp_trait_method_call_hierarchy() {
    let declaration = description("T1::callee", "trait_calls.rs", 2, 2);
    let entry = description("caller", "trait_calls.rs", 11, 13);
    check_case(Case {
        name: "rust_lsp_trait_method_call_hierarchy",
        files: vec![SourceFile {
            path: "trait_calls.rs",
            source: r"trait T1 {
    fn callee();
}

struct S1;

impl T1 for S1 {
    fn callee() {}
}

fn caller() {
    S1::callee();
}
",
        }],
        queries: vec![
            Query {
                direction: "in",
                symbol: "T1::callee",
                expected: vec![relationships(&declaration, &[(&entry, 12, 8)])],
            },
            Query {
                direction: "out",
                symbol: "T1::callee",
                expected: vec![relationships(&declaration, &[])],
            },
        ],
    })
    .await;
}

// zvec-grep-specific self/this receiver regression.
// Resolve each explicit receiver against its enclosing type; the two foo definitions must not mix.
#[tokio::test]
async fn java_self_this_direct_receiver() {
    let left_method = description("Left::foo", "receivers.java", 2, 2);
    let left_entry = description("Left::caller", "receivers.java", 3, 5);
    let right_method = description("Right::foo", "receivers.java", 8, 8);
    let right_entry = description("Right::caller", "receivers.java", 9, 11);
    check_case(Case {
        name: "java_self_this_direct_receiver",
        files: vec![SourceFile {
            path: "receivers.java",
            source: r"class Left {
    void foo() {}
    void caller() {
        this.foo();
    }
}
class Right {
    void foo() {}
    void caller() {
        this.foo();
    }
}
",
        }],
        queries: vec![
            Query {
                direction: "in",
                symbol: "foo",
                expected: vec![
                    relationships(&left_method, &[(&left_entry, 4, 13)]),
                    relationships(&right_method, &[(&right_entry, 10, 13)]),
                ],
            },
            Query {
                direction: "out",
                symbol: "Left::caller",
                expected: vec![relationships(&left_entry, &[(&left_method, 4, 13)])],
            },
            Query {
                direction: "out",
                symbol: "Right::caller",
                expected: vec![relationships(&right_entry, &[(&right_method, 10, 13)])],
            },
            Query {
                direction: "in",
                symbol: "Left::foo",
                expected: vec![relationships(&left_method, &[(&left_entry, 4, 13)])],
            },
        ],
    })
    .await;
}

// zvec-grep-specific self/this receiver regression.
// Resolve each explicit receiver against its enclosing type; the two foo definitions must not mix.
#[tokio::test]
async fn cpp_self_this_direct_receiver() {
    let left_method = description("Left::foo", "receivers.cc", 2, 2);
    let left_entry = description("Left::caller", "receivers.cc", 3, 5);
    let right_method = description("Right::foo", "receivers.cc", 8, 8);
    let right_entry = description("Right::caller", "receivers.cc", 9, 11);
    check_case(Case {
        name: "cpp_self_this_direct_receiver",
        files: vec![SourceFile {
            path: "receivers.cc",
            source: r"struct Left {
    void foo() {}
    void caller() {
        this->foo();
    }
};
struct Right {
    void foo() {}
    void caller() {
        this->foo();
    }
};
",
        }],
        queries: vec![
            Query {
                direction: "in",
                symbol: "foo",
                expected: vec![
                    relationships(&left_method, &[(&left_entry, 4, 14)]),
                    relationships(&right_method, &[(&right_entry, 10, 14)]),
                ],
            },
            Query {
                direction: "out",
                symbol: "Left::caller",
                expected: vec![relationships(&left_entry, &[(&left_method, 4, 14)])],
            },
            Query {
                direction: "out",
                symbol: "Right::caller",
                expected: vec![relationships(&right_entry, &[(&right_method, 10, 14)])],
            },
            Query {
                direction: "in",
                symbol: "Left::foo",
                expected: vec![relationships(&left_method, &[(&left_entry, 4, 14)])],
            },
        ],
    })
    .await;
}

// zvec-grep-specific self/this receiver regression.
// Resolve each explicit receiver against its enclosing type; the two foo definitions must not mix.
#[tokio::test]
async fn rust_self_this_direct_receiver() {
    let left_method = description("Left::foo", "receivers.rs", 3, 3);
    let left_entry = description("Left::caller", "receivers.rs", 4, 6);
    let right_method = description("Right::foo", "receivers.rs", 10, 10);
    let right_entry = description("Right::caller", "receivers.rs", 11, 13);
    check_case(Case {
        name: "rust_self_this_direct_receiver",
        files: vec![SourceFile {
            path: "receivers.rs",
            source: r"struct Left;
impl Left {
    fn foo(&self) {}
    fn caller(&self) {
        self.foo();
    }
}
struct Right;
impl Right {
    fn foo(&self) {}
    fn caller(&self) {
        self.foo();
    }
}
",
        }],
        queries: vec![
            Query {
                direction: "in",
                symbol: "foo",
                expected: vec![
                    relationships(&left_method, &[(&left_entry, 5, 13)]),
                    relationships(&right_method, &[(&right_entry, 12, 13)]),
                ],
            },
            Query {
                direction: "out",
                symbol: "Left::caller",
                expected: vec![relationships(&left_entry, &[(&left_method, 5, 13)])],
            },
            Query {
                direction: "out",
                symbol: "Right::caller",
                expected: vec![relationships(&right_entry, &[(&right_method, 12, 13)])],
            },
            Query {
                direction: "in",
                symbol: "Left::foo",
                expected: vec![relationships(&left_method, &[(&left_entry, 5, 13)])],
            },
        ],
    })
    .await;
}

// zvec-grep-specific self/this receiver regression.
// Resolve each explicit receiver against its enclosing type; the two foo definitions must not mix.
#[tokio::test]
async fn typescript_self_this_direct_receiver() {
    let left_method = description("Left::foo", "receivers.ts", 2, 2);
    let left_entry = description("Left::caller", "receivers.ts", 3, 5);
    let right_method = description("Right::foo", "receivers.ts", 8, 8);
    let right_entry = description("Right::caller", "receivers.ts", 9, 11);
    check_case(Case {
        name: "typescript_self_this_direct_receiver",
        files: vec![SourceFile {
            path: "receivers.ts",
            source: r"class Left {
    foo() {}
    caller() {
        this.foo();
    }
}
class Right {
    foo() {}
    caller() {
        this.foo();
    }
}
",
        }],
        queries: vec![
            Query {
                direction: "in",
                symbol: "foo",
                expected: vec![
                    relationships(&left_method, &[(&left_entry, 4, 13)]),
                    relationships(&right_method, &[(&right_entry, 10, 13)]),
                ],
            },
            Query {
                direction: "out",
                symbol: "Left::caller",
                expected: vec![relationships(&left_entry, &[(&left_method, 4, 13)])],
            },
            Query {
                direction: "out",
                symbol: "Right::caller",
                expected: vec![relationships(&right_entry, &[(&right_method, 10, 13)])],
            },
            Query {
                direction: "in",
                symbol: "Left::foo",
                expected: vec![relationships(&left_method, &[(&left_entry, 4, 13)])],
            },
        ],
    })
    .await;
}

// zvec-grep-specific self/this receiver regression.
// Resolve each explicit receiver against its enclosing type; the two foo definitions must not mix.
// The first instance-method parameter is named me, not self; parameter binding determines the receiver.
#[tokio::test]
async fn python_self_this_named_me_receiver() {
    let left_method = description("Left::foo", "receivers.py", 2, 3);
    let left_entry = description("Left::caller", "receivers.py", 4, 5);
    let right_method = description("Right::foo", "receivers.py", 7, 8);
    let right_entry = description("Right::caller", "receivers.py", 9, 10);
    check_case(Case {
        name: "python_self_this_named_me_receiver",
        files: vec![SourceFile {
            path: "receivers.py",
            source: r"class Left:
    def foo(me):
        pass
    def caller(me):
        me.foo()
class Right:
    def foo(me):
        pass
    def caller(me):
        me.foo()
",
        }],
        queries: vec![
            Query {
                direction: "in",
                symbol: "foo",
                expected: vec![
                    relationships(&left_method, &[(&left_entry, 5, 11)]),
                    relationships(&right_method, &[(&right_entry, 10, 11)]),
                ],
            },
            Query {
                direction: "out",
                symbol: "Left::caller",
                expected: vec![relationships(&left_entry, &[(&left_method, 5, 11)])],
            },
            Query {
                direction: "out",
                symbol: "Right::caller",
                expected: vec![relationships(&right_entry, &[(&right_method, 10, 11)])],
            },
            Query {
                direction: "in",
                symbol: "Left::foo",
                expected: vec![relationships(&left_method, &[(&left_entry, 5, 11)])],
            },
        ],
    })
    .await;
}

// zvec-grep-specific self/this receiver regression.
// The current type has no foo definition; self/this must resolve to inherited Base::foo.
// The unrelated Other::foo must have no incoming calls.
#[tokio::test]
async fn java_self_this_inherited_receiver() {
    let base = description("Base::foo", "inheritance.java", 2, 2);
    let entry = description("Derived::caller", "inheritance.java", 5, 7);
    let other = description("Other::foo", "inheritance.java", 10, 10);
    check_case(Case {
        name: "java_self_this_inherited_receiver",
        files: vec![SourceFile {
            path: "inheritance.java",
            source: r"class Base {
    void foo() {}
}
class Derived extends Base {
    void caller() {
        this.foo();
    }
}
class Other {
    void foo() {}
}
",
        }],
        queries: vec![
            Query {
                direction: "in",
                symbol: "foo",
                expected: vec![
                    relationships(&base, &[(&entry, 6, 13)]),
                    relationships(&other, &[]),
                ],
            },
            Query {
                direction: "out",
                symbol: "Derived::caller",
                expected: vec![relationships(&entry, &[(&base, 6, 13)])],
            },
            Query {
                direction: "in",
                symbol: "Base::foo",
                expected: vec![relationships(&base, &[(&entry, 6, 13)])],
            },
        ],
    })
    .await;
}

// zvec-grep-specific self/this receiver regression.
// An explicit parent call selects Base::foo even though Derived defines foo too.
// Derived::foo and the unrelated Other::foo must have no incoming calls.
#[tokio::test]
async fn java_self_this_explicit_parent_receiver() {
    let base = description("Base::foo", "inheritance.java", 2, 2);
    let derived = description("Derived::foo", "inheritance.java", 5, 5);
    let entry = description("Derived::caller", "inheritance.java", 6, 8);
    let other = description("Other::foo", "inheritance.java", 11, 11);
    check_case(Case {
        name: "java_self_this_explicit_parent_receiver",
        files: vec![SourceFile {
            path: "inheritance.java",
            source: r"class Base {
    void foo() {}
}
class Derived extends Base {
    void foo() {}
    void caller() {
        super.foo();
    }
}
class Other {
    void foo() {}
}
",
        }],
        queries: vec![
            Query {
                direction: "in",
                symbol: "foo",
                expected: vec![
                    relationships(&base, &[(&entry, 7, 14)]),
                    relationships(&derived, &[]),
                    relationships(&other, &[]),
                ],
            },
            Query {
                direction: "out",
                symbol: "Derived::caller",
                expected: vec![relationships(&entry, &[(&base, 7, 14)])],
            },
            Query {
                direction: "in",
                symbol: "Base::foo",
                expected: vec![relationships(&base, &[(&entry, 7, 14)])],
            },
        ],
    })
    .await;
}

// zvec-grep-specific self/this receiver regression.
// The current type has no foo definition; self/this must resolve to inherited Base::foo.
// The unrelated Other::foo must have no incoming calls.
// Methods are non-virtual so this fixture does not require any speculative override expansion.
#[tokio::test]
async fn cpp_self_this_inherited_receiver() {
    let base = description("Base::foo", "inheritance.cc", 2, 2);
    let entry = description("Derived::caller", "inheritance.cc", 5, 7);
    let other = description("Other::foo", "inheritance.cc", 10, 10);
    check_case(Case {
        name: "cpp_self_this_inherited_receiver",
        files: vec![SourceFile {
            path: "inheritance.cc",
            source: r"struct Base {
    void foo() {}
};
struct Derived : Base {
    void caller() {
        this->foo();
    }
};
struct Other {
    void foo() {}
};
",
        }],
        queries: vec![
            Query {
                direction: "in",
                symbol: "foo",
                expected: vec![
                    relationships(&base, &[(&entry, 6, 14)]),
                    relationships(&other, &[]),
                ],
            },
            Query {
                direction: "out",
                symbol: "Derived::caller",
                expected: vec![relationships(&entry, &[(&base, 6, 14)])],
            },
            Query {
                direction: "in",
                symbol: "Base::foo",
                expected: vec![relationships(&base, &[(&entry, 6, 14)])],
            },
        ],
    })
    .await;
}

// zvec-grep-specific self/this receiver regression.
// An explicit parent call selects Base::foo even though Derived defines foo too.
// Derived::foo and the unrelated Other::foo must have no incoming calls.
// Methods are non-virtual so this fixture does not require any speculative override expansion.
#[tokio::test]
async fn cpp_self_this_explicit_parent_receiver() {
    let base = description("Base::foo", "inheritance.cc", 2, 2);
    let derived = description("Derived::foo", "inheritance.cc", 5, 5);
    let entry = description("Derived::caller", "inheritance.cc", 6, 8);
    let other = description("Other::foo", "inheritance.cc", 11, 11);
    check_case(Case {
        name: "cpp_self_this_explicit_parent_receiver",
        files: vec![SourceFile {
            path: "inheritance.cc",
            source: r"struct Base {
    void foo() {}
};
struct Derived : Base {
    void foo() {}
    void caller() {
        Base::foo();
    }
};
struct Other {
    void foo() {}
};
",
        }],
        queries: vec![
            Query {
                direction: "in",
                symbol: "foo",
                expected: vec![
                    relationships(&base, &[(&entry, 7, 14)]),
                    relationships(&derived, &[]),
                    relationships(&other, &[]),
                ],
            },
            Query {
                direction: "out",
                symbol: "Derived::caller",
                expected: vec![relationships(&entry, &[(&base, 7, 14)])],
            },
            Query {
                direction: "in",
                symbol: "Base::foo",
                expected: vec![relationships(&base, &[(&entry, 7, 14)])],
            },
        ],
    })
    .await;
}

// zvec-grep-specific self/this receiver regression.
// The current type has no foo definition; self/this must resolve to inherited Base::foo.
// The unrelated Other::foo must have no incoming calls.
#[tokio::test]
async fn javascript_self_this_inherited_receiver() {
    let base = description("Base::foo", "inheritance.js", 2, 2);
    let entry = description("Derived::caller", "inheritance.js", 5, 7);
    let other = description("Other::foo", "inheritance.js", 10, 10);
    check_case(Case {
        name: "javascript_self_this_inherited_receiver",
        files: vec![SourceFile {
            path: "inheritance.js",
            source: r"class Base {
    foo() {}
}
class Derived extends Base {
    caller() {
        this.foo();
    }
}
class Other {
    foo() {}
}
",
        }],
        queries: vec![
            Query {
                direction: "in",
                symbol: "foo",
                expected: vec![
                    relationships(&base, &[(&entry, 6, 13)]),
                    relationships(&other, &[]),
                ],
            },
            Query {
                direction: "out",
                symbol: "Derived::caller",
                expected: vec![relationships(&entry, &[(&base, 6, 13)])],
            },
            Query {
                direction: "in",
                symbol: "Base::foo",
                expected: vec![relationships(&base, &[(&entry, 6, 13)])],
            },
        ],
    })
    .await;
}

// zvec-grep-specific self/this receiver regression.
// An explicit parent call selects Base::foo even though Derived defines foo too.
// Derived::foo and the unrelated Other::foo must have no incoming calls.
#[tokio::test]
async fn javascript_self_this_explicit_parent_receiver() {
    let base = description("Base::foo", "inheritance.js", 2, 2);
    let derived = description("Derived::foo", "inheritance.js", 5, 5);
    let entry = description("Derived::caller", "inheritance.js", 6, 8);
    let other = description("Other::foo", "inheritance.js", 11, 11);
    check_case(Case {
        name: "javascript_self_this_explicit_parent_receiver",
        files: vec![SourceFile {
            path: "inheritance.js",
            source: r"class Base {
    foo() {}
}
class Derived extends Base {
    foo() {}
    caller() {
        super.foo();
    }
}
class Other {
    foo() {}
}
",
        }],
        queries: vec![
            Query {
                direction: "in",
                symbol: "foo",
                expected: vec![
                    relationships(&base, &[(&entry, 7, 14)]),
                    relationships(&derived, &[]),
                    relationships(&other, &[]),
                ],
            },
            Query {
                direction: "out",
                symbol: "Derived::caller",
                expected: vec![relationships(&entry, &[(&base, 7, 14)])],
            },
            Query {
                direction: "in",
                symbol: "Base::foo",
                expected: vec![relationships(&base, &[(&entry, 7, 14)])],
            },
        ],
    })
    .await;
}

// zvec-grep-specific self/this receiver regression.
// The current type has no foo definition; self/this must resolve to inherited Base::foo.
// The unrelated Other::foo must have no incoming calls.
#[tokio::test]
async fn typescript_self_this_inherited_receiver() {
    let base = description("Base::foo", "inheritance.ts", 2, 2);
    let entry = description("Derived::caller", "inheritance.ts", 5, 7);
    let other = description("Other::foo", "inheritance.ts", 10, 10);
    check_case(Case {
        name: "typescript_self_this_inherited_receiver",
        files: vec![SourceFile {
            path: "inheritance.ts",
            source: r"class Base {
    foo() {}
}
class Derived extends Base {
    caller() {
        this.foo();
    }
}
class Other {
    foo() {}
}
",
        }],
        queries: vec![
            Query {
                direction: "in",
                symbol: "foo",
                expected: vec![
                    relationships(&base, &[(&entry, 6, 13)]),
                    relationships(&other, &[]),
                ],
            },
            Query {
                direction: "out",
                symbol: "Derived::caller",
                expected: vec![relationships(&entry, &[(&base, 6, 13)])],
            },
            Query {
                direction: "in",
                symbol: "Base::foo",
                expected: vec![relationships(&base, &[(&entry, 6, 13)])],
            },
        ],
    })
    .await;
}

// zvec-grep-specific self/this receiver regression.
// An explicit parent call selects Base::foo even though Derived defines foo too.
// Derived::foo and the unrelated Other::foo must have no incoming calls.
#[tokio::test]
async fn typescript_self_this_explicit_parent_receiver() {
    let base = description("Base::foo", "inheritance.ts", 2, 2);
    let derived = description("Derived::foo", "inheritance.ts", 5, 5);
    let entry = description("Derived::caller", "inheritance.ts", 6, 8);
    let other = description("Other::foo", "inheritance.ts", 11, 11);
    check_case(Case {
        name: "typescript_self_this_explicit_parent_receiver",
        files: vec![SourceFile {
            path: "inheritance.ts",
            source: r"class Base {
    foo() {}
}
class Derived extends Base {
    foo() {}
    caller() {
        super.foo();
    }
}
class Other {
    foo() {}
}
",
        }],
        queries: vec![
            Query {
                direction: "in",
                symbol: "foo",
                expected: vec![
                    relationships(&base, &[(&entry, 7, 14)]),
                    relationships(&derived, &[]),
                    relationships(&other, &[]),
                ],
            },
            Query {
                direction: "out",
                symbol: "Derived::caller",
                expected: vec![relationships(&entry, &[(&base, 7, 14)])],
            },
            Query {
                direction: "in",
                symbol: "Base::foo",
                expected: vec![relationships(&base, &[(&entry, 7, 14)])],
            },
        ],
    })
    .await;
}

// zvec-grep-specific self/this receiver regression.
// The current type has no foo definition; self/this must resolve to inherited Base::foo.
// The unrelated Other::foo must have no incoming calls.
#[tokio::test]
async fn python_self_this_inherited_receiver() {
    let base = description("Base::foo", "inheritance.py", 2, 3);
    let entry = description("Derived::caller", "inheritance.py", 5, 6);
    let other = description("Other::foo", "inheritance.py", 8, 9);
    check_case(Case {
        name: "python_self_this_inherited_receiver",
        files: vec![SourceFile {
            path: "inheritance.py",
            source: r"class Base:
    def foo(self):
        pass
class Derived(Base):
    def caller(self):
        self.foo()
class Other:
    def foo(self):
        pass
",
        }],
        queries: vec![
            Query {
                direction: "in",
                symbol: "foo",
                expected: vec![
                    relationships(&base, &[(&entry, 6, 13)]),
                    relationships(&other, &[]),
                ],
            },
            Query {
                direction: "out",
                symbol: "Derived::caller",
                expected: vec![relationships(&entry, &[(&base, 6, 13)])],
            },
            Query {
                direction: "in",
                symbol: "Base::foo",
                expected: vec![relationships(&base, &[(&entry, 6, 13)])],
            },
        ],
    })
    .await;
}

// zvec-grep-specific self/this receiver regression.
// An explicit parent call selects Base::foo even though Derived defines foo too.
// Derived::foo and the unrelated Other::foo must have no incoming calls.
// The builtin super() has no indexed definition and must not produce a synthetic call target.
#[tokio::test]
async fn python_self_this_explicit_parent_receiver() {
    let base = description("Base::foo", "inheritance.py", 2, 3);
    let derived = description("Derived::foo", "inheritance.py", 5, 6);
    let entry = description("Derived::caller", "inheritance.py", 7, 8);
    let other = description("Other::foo", "inheritance.py", 10, 11);
    check_case(Case {
        name: "python_self_this_explicit_parent_receiver",
        files: vec![SourceFile {
            path: "inheritance.py",
            source: r"class Base:
    def foo(self):
        pass
class Derived(Base):
    def foo(self):
        pass
    def caller(self):
        super().foo()
class Other:
    def foo(self):
        pass
",
        }],
        queries: vec![
            Query {
                direction: "in",
                symbol: "foo",
                expected: vec![
                    relationships(&base, &[(&entry, 8, 16)]),
                    relationships(&derived, &[]),
                    relationships(&other, &[]),
                ],
            },
            Query {
                direction: "out",
                symbol: "Derived::caller",
                expected: vec![relationships(&entry, &[(&base, 8, 16)])],
            },
            Query {
                direction: "in",
                symbol: "Base::foo",
                expected: vec![relationships(&base, &[(&entry, 8, 16)])],
            },
        ],
    })
    .await;
}

// zvec-grep-specific module-alias regression: import module as alias binds a module namespace.
// Both modules export work and stop. Calls resolve to the original work definitions, preserve
// repeated sites and never cross modules; namespace imports do not call the unused stop exports.
#[tokio::test]
async fn python_module_alias_calls() {
    let left = description("work", "left.py", 1, 2);
    let right = description("work", "right.py", 1, 2);
    let left_unused = description("stop", "left.py", 4, 5);
    let right_unused = description("stop", "right.py", 4, 5);
    let entry = description("caller", "caller.py", 3, 6);
    check_case(Case {
        name: "python_module_alias_calls",
        files: vec![
            SourceFile {
                path: "left.py",
                source: r"def work():
    pass

def stop():
    pass
",
            },
            SourceFile {
                path: "right.py",
                source: r"def work():
    pass

def stop():
    pass
",
            },
            SourceFile {
                path: "caller.py",
                source: r"import left as left_api
import right as right_api
def caller():
    left_api.work()
    right_api.work()
    left_api.work()
",
            },
        ],
        queries: vec![
            Query {
                direction: "out",
                symbol: "caller",
                expected: vec![relationships(
                    &entry,
                    &[(&left, 4, 13), (&right, 5, 14), (&left, 6, 13)],
                )],
            },
            Query {
                direction: "in",
                symbol: "work",
                expected: vec![
                    relationships(&left, &[(&entry, 4, 13), (&entry, 6, 13)]),
                    relationships(&right, &[(&entry, 5, 14)]),
                ],
            },
            Query {
                direction: "in",
                symbol: "stop",
                expected: vec![
                    relationships(&left_unused, &[]),
                    relationships(&right_unused, &[]),
                ],
            },
        ],
    })
    .await;
}

// zvec-grep-specific module-alias regression: import * as alias binds a module namespace.
// Both modules export work and stop. Calls resolve to the original work definitions, preserve
// repeated sites and never cross modules; namespace imports do not call the unused stop exports.
#[tokio::test]
async fn javascript_module_alias_calls() {
    let left = description("work", "left.js", 1, 1);
    let right = description("work", "right.js", 1, 1);
    let left_unused = description("stop", "left.js", 2, 2);
    let right_unused = description("stop", "right.js", 2, 2);
    let entry = description("caller", "caller.js", 3, 7);
    check_case(Case {
        name: "javascript_module_alias_calls",
        files: vec![
            SourceFile {
                path: "left.js",
                source: r"export function work() {}
export function stop() {}
",
            },
            SourceFile {
                path: "right.js",
                source: r"export function work() {}
export function stop() {}
",
            },
            SourceFile {
                path: "caller.js",
                source: r#"import * as leftApi from "./left";
import * as rightApi from "./right";
function caller() {
    leftApi.work();
    rightApi.work();
    leftApi.work();
}
"#,
            },
        ],
        queries: vec![
            Query {
                direction: "out",
                symbol: "caller",
                expected: vec![relationships(
                    &entry,
                    &[(&left, 4, 12), (&right, 5, 13), (&left, 6, 12)],
                )],
            },
            Query {
                direction: "in",
                symbol: "work",
                expected: vec![
                    relationships(&left, &[(&entry, 4, 12), (&entry, 6, 12)]),
                    relationships(&right, &[(&entry, 5, 13)]),
                ],
            },
            Query {
                direction: "in",
                symbol: "stop",
                expected: vec![
                    relationships(&left_unused, &[]),
                    relationships(&right_unused, &[]),
                ],
            },
        ],
    })
    .await;
}

// zvec-grep-specific module-alias regression: import * as alias binds a module namespace.
// Both modules export work and stop. Calls resolve to the original work definitions, preserve
// repeated sites and never cross modules; namespace imports do not call the unused stop exports.
#[tokio::test]
async fn typescript_module_alias_calls() {
    let left = description("work", "left.ts", 1, 1);
    let right = description("work", "right.ts", 1, 1);
    let left_unused = description("stop", "left.ts", 2, 2);
    let right_unused = description("stop", "right.ts", 2, 2);
    let entry = description("caller", "caller.ts", 3, 7);
    check_case(Case {
        name: "typescript_module_alias_calls",
        files: vec![
            SourceFile {
                path: "left.ts",
                source: r"export function work() {}
export function stop() {}
",
            },
            SourceFile {
                path: "right.ts",
                source: r"export function work() {}
export function stop() {}
",
            },
            SourceFile {
                path: "caller.ts",
                source: r#"import * as leftApi from "./left";
import * as rightApi from "./right";
function caller() {
    leftApi.work();
    rightApi.work();
    leftApi.work();
}
"#,
            },
        ],
        queries: vec![
            Query {
                direction: "out",
                symbol: "caller",
                expected: vec![relationships(
                    &entry,
                    &[(&left, 4, 12), (&right, 5, 13), (&left, 6, 12)],
                )],
            },
            Query {
                direction: "in",
                symbol: "work",
                expected: vec![
                    relationships(&left, &[(&entry, 4, 12), (&entry, 6, 12)]),
                    relationships(&right, &[(&entry, 5, 13)]),
                ],
            },
            Query {
                direction: "in",
                symbol: "stop",
                expected: vec![
                    relationships(&left_unused, &[]),
                    relationships(&right_unused, &[]),
                ],
            },
        ],
    })
    .await;
}

// zvec-grep-specific binding regression.
// The imported run alias works in control, but a nearer binding hides it in shadowed.
// The local run variable points to local_target; its call must resolve there, not to library.work.
#[tokio::test]
async fn python_binding_import_alias_local_shadow() {
    let imported = description("work", "library.py", 1, 2);
    let shadowed = description("shadowed", "caller.py", 4, 6);
    let control = description("control", "caller.py", 7, 8);
    let local = description("local_target", "caller.py", 2, 3);
    check_case(Case {
        name: "python_binding_import_alias_local_shadow",
        files: vec![
            SourceFile {
                path: "library.py",
                source: r"def work():
    pass
",
            },
            SourceFile {
                path: "caller.py",
                source: r"from library import work as run
def local_target():
    pass
def shadowed():
    run = local_target
    run()
def control():
    run()
",
            },
        ],
        queries: vec![
            Query {
                direction: "in",
                symbol: "work",
                expected: vec![relationships(&imported, &[(&control, 8, 4)])],
            },
            Query {
                direction: "out",
                symbol: "shadowed",
                expected: vec![relationships(&shadowed, &[(&local, 6, 4)])],
            },
            Query {
                direction: "out",
                symbol: "control",
                expected: vec![relationships(&control, &[(&imported, 8, 4)])],
            },
            Query {
                direction: "in",
                symbol: "local_target",
                expected: vec![relationships(&local, &[(&shadowed, 6, 4)])],
            },
        ],
    })
    .await;
}

// zvec-grep-specific binding regression.
// The imported run alias works in control, but a nearer binding hides it in shadowed.
// The callback parameter has no known concrete target; its call stays unresolved.
#[tokio::test]
async fn python_binding_import_alias_parameter_shadow() {
    let imported = description("work", "library.py", 1, 2);
    let shadowed = description("shadowed", "caller.py", 2, 3);
    let control = description("control", "caller.py", 4, 5);
    check_case(Case {
        name: "python_binding_import_alias_parameter_shadow",
        files: vec![
            SourceFile {
                path: "library.py",
                source: r"def work():
    pass
",
            },
            SourceFile {
                path: "caller.py",
                source: r"from library import work as run
def shadowed(run):
    run()
def control():
    run()
",
            },
        ],
        queries: vec![
            Query {
                direction: "in",
                symbol: "work",
                expected: vec![relationships(&imported, &[(&control, 5, 4)])],
            },
            Query {
                direction: "out",
                symbol: "shadowed",
                expected: vec![relationships(&shadowed, &[])],
            },
            Query {
                direction: "out",
                symbol: "control",
                expected: vec![relationships(&control, &[(&imported, 5, 4)])],
            },
        ],
    })
    .await;
}

// zvec-grep-specific binding regression.
// The explicit import points outside the indexed workspace.
// A single same-named workspace definition is not evidence that it is the imported target.
// Keep the known direct call while leaving the unavailable dependency unresolved.
#[tokio::test]
async fn python_binding_unavailable_import_target() {
    let decoy = description("work", "decoy.py", 1, 2);
    let known = description("known", "caller.py", 2, 3);
    let entry = description("caller", "caller.py", 4, 6);
    check_case(Case {
        name: "python_binding_unavailable_import_target",
        files: vec![
            SourceFile {
                path: "decoy.py",
                source: r"def work():
    pass
",
            },
            SourceFile {
                path: "caller.py",
                source: r"from unindexed_lib import work as run
def known():
    pass
def caller():
    known()
    run()
",
            },
        ],
        queries: vec![
            Query {
                direction: "out",
                symbol: "caller",
                expected: vec![relationships(&entry, &[(&known, 5, 4)])],
            },
            Query {
                direction: "in",
                symbol: "work",
                expected: vec![relationships(&decoy, &[])],
            },
            Query {
                direction: "in",
                symbol: "known",
                expected: vec![relationships(&known, &[(&entry, 5, 4)])],
            },
        ],
    })
    .await;
}

// zvec-grep-specific binding regression.
// The external factory is imported from a dependency absent from the workspace.
// Neither its name nor its unknown return receiver may bind to the unrelated local make/foo.
// The known direct call must still be returned; unresolved calls have no resolved query edges.
#[tokio::test]
async fn python_binding_unknown_factory_receiver() {
    let decoy_factory = description("make", "decoy.py", 1, 2);
    let decoy_method = description("Local::foo", "decoy.py", 4, 5);
    let known = description("known", "caller.py", 2, 3);
    let entry = description("caller", "caller.py", 4, 6);
    check_case(Case {
        name: "python_binding_unknown_factory_receiver",
        files: vec![
            SourceFile {
                path: "decoy.py",
                source: r"def make():
    pass
class Local:
    def foo(self):
        pass
",
            },
            SourceFile {
                path: "caller.py",
                source: r"from unindexed_lib import make as external_factory
def known():
    pass
def caller():
    known()
    external_factory().foo()
",
            },
        ],
        queries: vec![
            Query {
                direction: "out",
                symbol: "caller",
                expected: vec![relationships(&entry, &[(&known, 5, 4)])],
            },
            Query {
                direction: "in",
                symbol: "make",
                expected: vec![relationships(&decoy_factory, &[])],
            },
            Query {
                direction: "in",
                symbol: "Local::foo",
                expected: vec![relationships(&decoy_method, &[])],
            },
            Query {
                direction: "in",
                symbol: "known",
                expected: vec![relationships(&known, &[(&entry, 5, 4)])],
            },
        ],
    })
    .await;
}

// zvec-grep-specific binding regression.
// The imported run alias works in control, but a nearer binding hides it in shadowed.
// The local run variable points to local_target; its call must resolve there, not to library.work.
#[tokio::test]
async fn javascript_binding_import_alias_local_shadow() {
    let imported = description("work", "library.js", 1, 1);
    let shadowed = description("shadowed", "caller.js", 3, 6);
    let control = description("control", "caller.js", 7, 9);
    let local = description("local_target", "caller.js", 2, 2);
    check_case(Case {
        name: "javascript_binding_import_alias_local_shadow",
        files: vec![
            SourceFile {
                path: "library.js",
                source: r"export function work() {}
",
            },
            SourceFile {
                path: "caller.js",
                source: r#"import { work as run } from "./library";
function local_target() {}
function shadowed() {
    const run = local_target;
    run();
}
function control() {
    run();
}
"#,
            },
        ],
        queries: vec![
            Query {
                direction: "in",
                symbol: "work",
                expected: vec![relationships(&imported, &[(&control, 8, 4)])],
            },
            Query {
                direction: "out",
                symbol: "shadowed",
                expected: vec![relationships(&shadowed, &[(&local, 5, 4)])],
            },
            Query {
                direction: "out",
                symbol: "control",
                expected: vec![relationships(&control, &[(&imported, 8, 4)])],
            },
            Query {
                direction: "in",
                symbol: "local_target",
                expected: vec![relationships(&local, &[(&shadowed, 5, 4)])],
            },
        ],
    })
    .await;
}

// zvec-grep-specific binding regression.
// The imported run alias works in control, but a nearer binding hides it in shadowed.
// The callback parameter has no known concrete target; its call stays unresolved.
#[tokio::test]
async fn javascript_binding_import_alias_parameter_shadow() {
    let imported = description("work", "library.js", 1, 1);
    let shadowed = description("shadowed", "caller.js", 2, 4);
    let control = description("control", "caller.js", 5, 7);
    check_case(Case {
        name: "javascript_binding_import_alias_parameter_shadow",
        files: vec![
            SourceFile {
                path: "library.js",
                source: r"export function work() {}
",
            },
            SourceFile {
                path: "caller.js",
                source: r#"import { work as run } from "./library";
function shadowed(run) {
    run();
}
function control() {
    run();
}
"#,
            },
        ],
        queries: vec![
            Query {
                direction: "in",
                symbol: "work",
                expected: vec![relationships(&imported, &[(&control, 6, 4)])],
            },
            Query {
                direction: "out",
                symbol: "shadowed",
                expected: vec![relationships(&shadowed, &[])],
            },
            Query {
                direction: "out",
                symbol: "control",
                expected: vec![relationships(&control, &[(&imported, 6, 4)])],
            },
        ],
    })
    .await;
}

// zvec-grep-specific binding regression.
// The explicit import points outside the indexed workspace.
// A single same-named workspace definition is not evidence that it is the imported target.
// Keep the known direct call while leaving the unavailable dependency unresolved.
#[tokio::test]
async fn javascript_binding_unavailable_import_target() {
    let decoy = description("work", "decoy.js", 1, 1);
    let known = description("known", "caller.js", 2, 2);
    let entry = description("caller", "caller.js", 3, 6);
    check_case(Case {
        name: "javascript_binding_unavailable_import_target",
        files: vec![
            SourceFile {
                path: "decoy.js",
                source: r"export function work() {}
",
            },
            SourceFile {
                path: "caller.js",
                source: r#"import { work as run } from "unindexed-lib";
function known() {}
function caller() {
    known();
    run();
}
"#,
            },
        ],
        queries: vec![
            Query {
                direction: "out",
                symbol: "caller",
                expected: vec![relationships(&entry, &[(&known, 4, 4)])],
            },
            Query {
                direction: "in",
                symbol: "work",
                expected: vec![relationships(&decoy, &[])],
            },
            Query {
                direction: "in",
                symbol: "known",
                expected: vec![relationships(&known, &[(&entry, 4, 4)])],
            },
        ],
    })
    .await;
}

// zvec-grep-specific binding regression.
// The external factory is imported from a dependency absent from the workspace.
// Neither its name nor its unknown return receiver may bind to the unrelated local make/foo.
// The known direct call must still be returned; unresolved calls have no resolved query edges.
#[tokio::test]
async fn javascript_binding_unknown_factory_receiver() {
    let decoy_factory = description("make", "decoy.js", 1, 1);
    let decoy_method = description("Local::foo", "decoy.js", 3, 3);
    let known = description("known", "caller.js", 2, 2);
    let entry = description("caller", "caller.js", 3, 6);
    check_case(Case {
        name: "javascript_binding_unknown_factory_receiver",
        files: vec![
            SourceFile {
                path: "decoy.js",
                source: r"export function make() {}
export class Local {
    foo() {}
}
",
            },
            SourceFile {
                path: "caller.js",
                source: r#"import { make as externalFactory } from "unindexed-lib";
function known() {}
function caller() {
    known();
    externalFactory().foo();
}
"#,
            },
        ],
        queries: vec![
            Query {
                direction: "out",
                symbol: "caller",
                expected: vec![relationships(&entry, &[(&known, 4, 4)])],
            },
            Query {
                direction: "in",
                symbol: "make",
                expected: vec![relationships(&decoy_factory, &[])],
            },
            Query {
                direction: "in",
                symbol: "Local::foo",
                expected: vec![relationships(&decoy_method, &[])],
            },
            Query {
                direction: "in",
                symbol: "known",
                expected: vec![relationships(&known, &[(&entry, 4, 4)])],
            },
        ],
    })
    .await;
}

// zvec-grep-specific binding regression.
// The imported run alias works in control, but a nearer binding hides it in shadowed.
// The local run variable points to local_target; its call must resolve there, not to library.work.
#[tokio::test]
async fn typescript_binding_import_alias_local_shadow() {
    let imported = description("work", "library.ts", 1, 1);
    let shadowed = description("shadowed", "caller.ts", 3, 6);
    let control = description("control", "caller.ts", 7, 9);
    let local = description("local_target", "caller.ts", 2, 2);
    check_case(Case {
        name: "typescript_binding_import_alias_local_shadow",
        files: vec![
            SourceFile {
                path: "library.ts",
                source: r"export function work() {}
",
            },
            SourceFile {
                path: "caller.ts",
                source: r#"import { work as run } from "./library";
function local_target() {}
function shadowed() {
    const run = local_target;
    run();
}
function control() {
    run();
}
"#,
            },
        ],
        queries: vec![
            Query {
                direction: "in",
                symbol: "work",
                expected: vec![relationships(&imported, &[(&control, 8, 4)])],
            },
            Query {
                direction: "out",
                symbol: "shadowed",
                expected: vec![relationships(&shadowed, &[(&local, 5, 4)])],
            },
            Query {
                direction: "out",
                symbol: "control",
                expected: vec![relationships(&control, &[(&imported, 8, 4)])],
            },
            Query {
                direction: "in",
                symbol: "local_target",
                expected: vec![relationships(&local, &[(&shadowed, 5, 4)])],
            },
        ],
    })
    .await;
}

// zvec-grep-specific binding regression.
// The imported run alias works in control, but a nearer binding hides it in shadowed.
// The callback parameter has no known concrete target; its call stays unresolved.
#[tokio::test]
async fn typescript_binding_import_alias_parameter_shadow() {
    let imported = description("work", "library.ts", 1, 1);
    let shadowed = description("shadowed", "caller.ts", 2, 4);
    let control = description("control", "caller.ts", 5, 7);
    check_case(Case {
        name: "typescript_binding_import_alias_parameter_shadow",
        files: vec![
            SourceFile {
                path: "library.ts",
                source: r"export function work() {}
",
            },
            SourceFile {
                path: "caller.ts",
                source: r#"import { work as run } from "./library";
function shadowed(run: () => void) {
    run();
}
function control() {
    run();
}
"#,
            },
        ],
        queries: vec![
            Query {
                direction: "in",
                symbol: "work",
                expected: vec![relationships(&imported, &[(&control, 6, 4)])],
            },
            Query {
                direction: "out",
                symbol: "shadowed",
                expected: vec![relationships(&shadowed, &[])],
            },
            Query {
                direction: "out",
                symbol: "control",
                expected: vec![relationships(&control, &[(&imported, 6, 4)])],
            },
        ],
    })
    .await;
}

// zvec-grep-specific binding regression.
// The explicit import points outside the indexed workspace.
// A single same-named workspace definition is not evidence that it is the imported target.
// Keep the known direct call while leaving the unavailable dependency unresolved.
#[tokio::test]
async fn typescript_binding_unavailable_import_target() {
    let decoy = description("work", "decoy.ts", 1, 1);
    let known = description("known", "caller.ts", 2, 2);
    let entry = description("caller", "caller.ts", 3, 6);
    check_case(Case {
        name: "typescript_binding_unavailable_import_target",
        files: vec![
            SourceFile {
                path: "decoy.ts",
                source: r"export function work() {}
",
            },
            SourceFile {
                path: "caller.ts",
                source: r#"import { work as run } from "unindexed-lib";
function known() {}
function caller() {
    known();
    run();
}
"#,
            },
        ],
        queries: vec![
            Query {
                direction: "out",
                symbol: "caller",
                expected: vec![relationships(&entry, &[(&known, 4, 4)])],
            },
            Query {
                direction: "in",
                symbol: "work",
                expected: vec![relationships(&decoy, &[])],
            },
            Query {
                direction: "in",
                symbol: "known",
                expected: vec![relationships(&known, &[(&entry, 4, 4)])],
            },
        ],
    })
    .await;
}

// zvec-grep-specific binding regression.
// The external factory is imported from a dependency absent from the workspace.
// Neither its name nor its unknown return receiver may bind to the unrelated local make/foo.
// The known direct call must still be returned; unresolved calls have no resolved query edges.
#[tokio::test]
async fn typescript_binding_unknown_factory_receiver() {
    let decoy_factory = description("make", "decoy.ts", 1, 1);
    let decoy_method = description("Local::foo", "decoy.ts", 3, 3);
    let known = description("known", "caller.ts", 2, 2);
    let entry = description("caller", "caller.ts", 3, 6);
    check_case(Case {
        name: "typescript_binding_unknown_factory_receiver",
        files: vec![
            SourceFile {
                path: "decoy.ts",
                source: r"export function make() {}
export class Local {
    foo() {}
}
",
            },
            SourceFile {
                path: "caller.ts",
                source: r#"import { make as externalFactory } from "unindexed-lib";
function known() {}
function caller() {
    known();
    externalFactory().foo();
}
"#,
            },
        ],
        queries: vec![
            Query {
                direction: "out",
                symbol: "caller",
                expected: vec![relationships(&entry, &[(&known, 4, 4)])],
            },
            Query {
                direction: "in",
                symbol: "make",
                expected: vec![relationships(&decoy_factory, &[])],
            },
            Query {
                direction: "in",
                symbol: "Local::foo",
                expected: vec![relationships(&decoy_method, &[])],
            },
            Query {
                direction: "in",
                symbol: "known",
                expected: vec![relationships(&known, &[(&entry, 4, 4)])],
            },
        ],
    })
    .await;
}

// https://github.com/microsoft/TypeScript/blob/fed0bf24149fb1ed36039212648bafdafc1ea10e/tsc/internal/fourslash/tests/callHierarchyConstNamedClassExpression_test.go
// Upstream ConstNamedClassExpression.
// Strip the cursor marker and retain the upstream class-level constructor hierarchy.
// The variable supplies the anonymous class name Bar; constructor calls to baz belong to Bar.
// Reverse queries supplement the upstream incoming/outgoing checks and exclude transitive edges.
#[tokio::test]
async fn typescript_upstream_class_expression() {
    let entry = description("foo", "expression.ts", 1, 3);
    let target = description("Bar", "expression.ts", 5, 9);
    let leaf = description("baz", "expression.ts", 11, 12);
    check_case(Case {
        name: "typescript_upstream_class_expression",
        files: vec![SourceFile {
            path: "expression.ts",
            source: r"function foo() {
    new Bar();
}

const Bar = class {
    constructor() {
        baz();
    }
}

function baz() {
}
",
        }],
        queries: vec![
            Query {
                direction: "in",
                symbol: "Bar",
                expected: vec![relationships(&target, &[(&entry, 2, 8)])],
            },
            Query {
                direction: "out",
                symbol: "Bar",
                expected: vec![relationships(&target, &[(&leaf, 7, 8)])],
            },
            Query {
                direction: "out",
                symbol: "foo",
                expected: vec![relationships(&entry, &[(&target, 2, 8)])],
            },
            Query {
                direction: "in",
                symbol: "baz",
                expected: vec![relationships(&leaf, &[(&target, 7, 8)])],
            },
        ],
    })
    .await;
}

// https://github.com/microsoft/TypeScript/blob/fed0bf24149fb1ed36039212648bafdafc1ea10e/tsc/internal/fourslash/tests/callHierarchyExportDefaultClass_test.go
// Upstream ExportDefaultClass.
// Strip the cursor marker. The upstream canonical anonymous class name is default, not Bar.
// Preserve class-level ownership of constructor calls and add inverse queries for both edges.
#[tokio::test]
async fn typescript_upstream_default_export_class() {
    let entry = description("foo", "main.ts", 3, 5);
    let target = description("default", "other.ts", 1, 5);
    let leaf = description("baz", "other.ts", 7, 8);
    check_case(Case {
        name: "typescript_upstream_default_export_class",
        files: vec![
            SourceFile {
                path: "main.ts",
                source: r#"import Bar from "./other";

function foo() {
    new Bar();
}
"#,
            },
            SourceFile {
                path: "other.ts",
                source: r"export default class {
    constructor() {
        baz();
    }
}

function baz() {
}
",
            },
        ],
        queries: vec![
            Query {
                direction: "in",
                symbol: "default",
                expected: vec![relationships(&target, &[(&entry, 4, 8)])],
            },
            Query {
                direction: "out",
                symbol: "default",
                expected: vec![relationships(&target, &[(&leaf, 3, 8)])],
            },
            Query {
                direction: "out",
                symbol: "foo",
                expected: vec![relationships(&entry, &[(&target, 4, 8)])],
            },
            Query {
                direction: "in",
                symbol: "baz",
                expected: vec![relationships(&leaf, &[(&target, 3, 8)])],
            },
        ],
    })
    .await;
}

// https://github.com/microsoft/TypeScript/blob/fed0bf24149fb1ed36039212648bafdafc1ea10e/tsc/internal/fourslash/tests/callHierarchyExportEqualsFunction_test.go
// Upstream ExportEqualsFunction.
// Adapt the upstream anonymous export by naming its function exported for symbol-name queries.
// The original baseline returns a module item with no incoming calls; these function-level
// binding expectations are an explicit extension, not a copy of that module baseline.
// import = require() must reach exported, while baz remains its direct callee, not foo's.
#[tokio::test]
async fn typescript_upstream_export_equals() {
    let entry = description("foo", "main.ts", 3, 5);
    let target = description("exported", "other.ts", 1, 3);
    let leaf = description("baz", "other.ts", 5, 6);
    check_case(Case {
        name: "typescript_upstream_export_equals",
        files: vec![
            SourceFile {
                path: "main.ts",
                source: r#"import bar = require("./other");

function foo() {
    bar();
}
"#,
            },
            SourceFile {
                path: "other.ts",
                source: r"export = function exported() {
    baz();
}

function baz() {
}
",
            },
        ],
        queries: vec![
            Query {
                direction: "in",
                symbol: "exported",
                expected: vec![relationships(&target, &[(&entry, 4, 4)])],
            },
            Query {
                direction: "out",
                symbol: "exported",
                expected: vec![relationships(&target, &[(&leaf, 2, 4)])],
            },
            Query {
                direction: "out",
                symbol: "foo",
                expected: vec![relationships(&entry, &[(&target, 4, 4)])],
            },
            Query {
                direction: "in",
                symbol: "baz",
                expected: vec![relationships(&leaf, &[(&target, 2, 4)])],
            },
        ],
    })
    .await;
}

// https://github.com/microsoft/TypeScript/blob/fed0bf24149fb1ed36039212648bafdafc1ea10e/tsc/internal/fourslash/tests/callHierarchyJsxElement_test.go
// Upstream JsxElement.
// Strip the cursor marker and harness directives while preserving source lines in a TSX file.
// Adopt the upstream semantic call from JSX to the component function; no JSX runtime is indexed.
// The component owns its call to baz, which must not appear as a direct callee of foo.
#[tokio::test]
async fn typescript_upstream_jsx() {
    let entry = description("foo", "main.tsx", 1, 3);
    let target = description("Bar", "main.tsx", 5, 7);
    let leaf = description("baz", "main.tsx", 9, 10);
    check_case(Case {
        name: "typescript_upstream_jsx",
        files: vec![SourceFile {
            path: "main.tsx",
            source: r"function foo() {
    return <Bar/>;
}

function Bar() {
    baz();
}

function baz() {
}
",
        }],
        queries: vec![
            Query {
                direction: "in",
                symbol: "Bar",
                expected: vec![relationships(&target, &[(&entry, 2, 12)])],
            },
            Query {
                direction: "out",
                symbol: "Bar",
                expected: vec![relationships(&target, &[(&leaf, 6, 4)])],
            },
            Query {
                direction: "out",
                symbol: "foo",
                expected: vec![relationships(&entry, &[(&target, 2, 12)])],
            },
            Query {
                direction: "in",
                symbol: "baz",
                expected: vec![relationships(&leaf, &[(&target, 6, 4)])],
            },
        ],
    })
    .await;
}

// zvec-grep-specific C++ declaration/definition regression. Foo.h declares both methods;
// Foo.cc defines them, and a third translation unit calls bar through reference/pointer receivers.
// Canonical symbols and ranges must come from Foo.cc, with no duplicate header-declaration groups.
// Calls within the out-of-line bar definition belong to Foo::bar and resolve this against Foo.
#[tokio::test]
async fn cpp_class_header_and_implementation() {
    let bar = description("Foo::bar", "Foo.cc", 3, 5);
    let baz = description("Foo::baz", "Foo.cc", 7, 7);
    let entry = description("caller", "caller.cc", 2, 5);
    check_case(Case {
        name: "cpp_class_header_and_implementation",
        files: vec![
            SourceFile {
                path: "Foo.h",
                source: r"#pragma once
class Foo {
public:
    void bar();
    void baz();
};
",
            },
            SourceFile {
                path: "Foo.cc",
                source: r#"#include "Foo.h"

void Foo::bar() {
    this->baz();
}

void Foo::baz() {}
"#,
            },
            SourceFile {
                path: "caller.cc",
                source: r#"#include "Foo.h"
void caller(Foo& ref, Foo* ptr) {
    ref.bar();
    ptr->bar();
}
"#,
            },
        ],
        queries: vec![
            Query {
                direction: "in",
                symbol: "bar",
                expected: vec![relationships(&bar, &[(&entry, 3, 8), (&entry, 4, 9)])],
            },
            Query {
                direction: "in",
                symbol: "Foo::bar",
                expected: vec![relationships(&bar, &[(&entry, 3, 8), (&entry, 4, 9)])],
            },
            Query {
                direction: "out",
                symbol: "caller",
                expected: vec![relationships(&entry, &[(&bar, 3, 8), (&bar, 4, 9)])],
            },
            Query {
                direction: "out",
                symbol: "Foo::bar",
                expected: vec![relationships(&bar, &[(&baz, 4, 10)])],
            },
            Query {
                direction: "in",
                symbol: "baz",
                expected: vec![relationships(&baz, &[(&bar, 4, 10)])],
            },
            Query {
                direction: "out",
                symbol: "Foo::baz",
                expected: vec![relationships(&baz, &[])],
            },
        ],
    })
    .await;
}

// zvec-grep-specific C++ template regression. Explicit type arguments select one source template
// definition. Different instantiations must not create separate symbol groups, while repeated
// calls to the same instantiation retain their individual source sites.
#[tokio::test]
async fn cpp_template_explicit_arguments() {
    let target = description("work", "explicit.cc", 1, 1);
    let entry = description("caller", "explicit.cc", 2, 6);
    check_case(Case {
        name: "cpp_template_explicit_arguments",
        files: vec![SourceFile {
            path: "explicit.cc",
            source: r"template <typename T> void work(T value) {}
void caller() {
    work<int>(1);
    work<double>(2.0);
    work<int>(3);
}
",
        }],
        queries: vec![
            Query {
                direction: "in",
                symbol: "work",
                expected: vec![relationships(
                    &target,
                    &[(&entry, 3, 4), (&entry, 4, 4), (&entry, 5, 4)],
                )],
            },
            Query {
                direction: "out",
                symbol: "caller",
                expected: vec![relationships(
                    &entry,
                    &[(&target, 3, 4), (&target, 4, 4), (&target, 5, 4)],
                )],
            },
            Query {
                direction: "out",
                symbol: "work",
                expected: vec![relationships(&target, &[])],
            },
        ],
    })
    .await;
}

// zvec-grep-specific C++ template regression. Calls with int, double and char arguments deduce T
// without explicit angle brackets. All three calls refer to the same source template definition;
// parameter and argument types are not additional call targets.
#[tokio::test]
async fn cpp_template_deduced_arguments() {
    let target = description("work", "deduced.cc", 1, 1);
    let entry = description("caller", "deduced.cc", 2, 6);
    check_case(Case {
        name: "cpp_template_deduced_arguments",
        files: vec![SourceFile {
            path: "deduced.cc",
            source: r"template <typename T> void work(T value) {}
void caller() {
    work(1);
    work(2.0);
    work('a');
}
",
        }],
        queries: vec![
            Query {
                direction: "in",
                symbol: "work",
                expected: vec![relationships(
                    &target,
                    &[(&entry, 3, 4), (&entry, 4, 4), (&entry, 5, 4)],
                )],
            },
            Query {
                direction: "out",
                symbol: "caller",
                expected: vec![relationships(
                    &entry,
                    &[(&target, 3, 4), (&target, 4, 4), (&target, 5, 4)],
                )],
            },
            Query {
                direction: "out",
                symbol: "work",
                expected: vec![relationships(&target, &[])],
            },
        ],
    })
    .await;
}

// zvec-grep-specific C++ template regression. Non-dependent helper calls belong to the source
// template, not its callers. Two instantiations must not multiply the template's two callsites;
// caller's direct callees remain work alone. Dependent lookup/overload selection is outside this case.
#[tokio::test]
async fn cpp_template_body_call_ownership() {
    let helper = description("helper", "body.cc", 1, 1);
    let target = description("work", "body.cc", 2, 5);
    let entry = description("caller", "body.cc", 6, 9);
    check_case(Case {
        name: "cpp_template_body_call_ownership",
        files: vec![SourceFile {
            path: "body.cc",
            source: r"void helper() {}
template <typename T> void work(T value) {
    helper();
    helper();
}
void caller() {
    work<int>(1);
    work(2.0);
}
",
        }],
        queries: vec![
            Query {
                direction: "in",
                symbol: "work",
                expected: vec![relationships(&target, &[(&entry, 7, 4), (&entry, 8, 4)])],
            },
            Query {
                direction: "out",
                symbol: "caller",
                expected: vec![relationships(&entry, &[(&target, 7, 4), (&target, 8, 4)])],
            },
            Query {
                direction: "out",
                symbol: "work",
                expected: vec![relationships(&target, &[(&helper, 3, 4), (&helper, 4, 4)])],
            },
            Query {
                direction: "in",
                symbol: "helper",
                expected: vec![relationships(&helper, &[(&target, 3, 4), (&target, 4, 4)])],
            },
        ],
    })
    .await;
}
