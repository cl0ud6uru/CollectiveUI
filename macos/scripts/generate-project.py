#!/usr/bin/env python3
"""Deterministic Xcode project; shared files are compiled directly, never copied."""
import hashlib
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
SHARED = [
    'App/AppModel.swift', 'Auth/KeychainStore.swift', 'Auth/WebAuthenticator.swift',
    'Chat/ChatModel.swift', 'Chat/ConversationState.swift', 'Chat/PendingChatSubmission.swift',
    'Demo/DemoMode.swift', 'Demo/DemoServer.swift', 'Demo/DemoFixtures.swift', 'Demo/DemoURLProtocol.swift',
    'Support/AvatarView.swift', 'Support/BotIdentityView.swift', 'Support/BotArtwork.swift',
    'Support/BotArtworkCache.swift', 'Support/PortalTheme.swift',
    'Demo/DemoPetArt.swift',
]
SHARED_TESTS = ['SessionAndDraftTests.swift', 'ChatLifecycleTests.swift', 'ChatRecoveryTests.swift', 'AuthenticationTests.swift', 'BotArtworkTests.swift']


def identifier(name):
    return hashlib.sha1(name.encode()).hexdigest()[:24].upper()


def generate():
    objects = []

    def obj(name, value):
        key = identifier(name)
        objects.append(f'\t\t{key} = {{ {value} }};')
        return key

    def refs(names):
        return '(' + ', '.join(identifier(n) for n in names) + ',)'

    native = sorted(str(p.relative_to(ROOT)) for p in (ROOT / 'CollectiveUI').rglob('*.swift'))
    shared = ['../ios/CollectiveUI/' + p for p in SHARED]
    tests = sorted(str(p.relative_to(ROOT)) for p in (ROOT / 'CollectiveUITests').rglob('*.swift'))
    tests += ['../ios/CollectiveUITests/' + p for p in SHARED_TESTS]
    app_sources = native + shared
    for path in app_sources + tests:
        obj('file:' + path, f'isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = {json.dumps(path)}; sourceTree = SOURCE_ROOT;')
        obj('build:' + path, f'isa = PBXBuildFile; fileRef = {identifier("file:" + path)};')
    for name, paths in [('Native', native), ('Shared', shared), ('Tests', tests)]:
        obj(name, f'isa = PBXGroup; name = {name}; children = {refs(["file:" + p for p in paths])}; sourceTree = "<group>";')
    obj('AppProduct', 'isa = PBXFileReference; explicitFileType = wrapper.application; path = CollectiveUI.app; sourceTree = BUILT_PRODUCTS_DIR;')
    obj('TestProduct', 'isa = PBXFileReference; explicitFileType = wrapper.cfbundle; path = CollectiveUITests.xctest; sourceTree = BUILT_PRODUCTS_DIR;')
    obj('Products', f'isa = PBXGroup; name = Products; children = {refs(["AppProduct", "TestProduct"])}; sourceTree = "<group>";')
    obj('Root', f'isa = PBXGroup; children = {refs(["Native", "Shared", "Tests", "Products"])}; sourceTree = "<group>";')
    for prefix, paths in [('App', app_sources), ('Test', tests)]:
        obj(prefix + 'Sources', f'isa = PBXSourcesBuildPhase; buildActionMask = 2147483647; files = {refs(["build:" + p for p in paths])}; runOnlyForDeploymentPostprocessing = 0;')
        obj(prefix + 'Frameworks', f'isa = PBXFrameworksBuildPhase; buildActionMask = 2147483647; files = {refs([prefix + "KitBuild"])}; runOnlyForDeploymentPostprocessing = 0;')
        obj(prefix + 'Resources', 'isa = PBXResourcesBuildPhase; buildActionMask = 2147483647; files = (); runOnlyForDeploymentPostprocessing = 0;')
        obj(prefix + 'Kit', f'isa = XCSwiftPackageProductDependency; package = {identifier("Package")}; productName = CollectiveKit;')
        obj(prefix + 'KitBuild', f'isa = PBXBuildFile; productRef = {identifier(prefix + "Kit")};')
    obj('Package', 'isa = XCLocalSwiftPackageReference; relativePath = ../ios/CollectiveKit;')
    obj('TestProxy', f'isa = PBXContainerItemProxy; containerPortal = {identifier("Project")}; proxyType = 1; remoteGlobalIDString = {identifier("AppTarget")}; remoteInfo = CollectiveUI;')
    obj('TestDependency', f'isa = PBXTargetDependency; target = {identifier("AppTarget")}; targetProxy = {identifier("TestProxy")};')
    for prefix, name, product_type in [('App', 'CollectiveUI', 'application'), ('Test', 'CollectiveUITests', 'bundle.unit-test')]:
        obj(prefix + 'Target', f'isa = PBXNativeTarget; buildConfigurationList = {identifier(prefix + "Config")}; buildPhases = {refs([prefix + "Sources", prefix + "Frameworks", prefix + "Resources"])}; buildRules = (); dependencies = {refs(["TestDependency"]) if prefix == "Test" else "()"}; name = {name}; productName = {name}; productReference = {identifier(prefix + "Product")}; productType = "com.apple.product-type.{product_type}"; packageProductDependencies = {refs([prefix + "Kit"])};')
    for configuration in ['Debug', 'Release']:
        debug = configuration == 'Debug'
        common = f'MACOSX_DEPLOYMENT_TARGET = 14.0; SDKROOT = macosx; SWIFT_VERSION = 5.0; CLANG_ENABLE_MODULES = YES; CLANG_ENABLE_OBJC_ARC = YES; ENABLE_TESTABILITY = {"YES" if debug else "NO"}; SWIFT_OPTIMIZATION_LEVEL = "{ "-Onone" if debug else "-O" }"; SWIFT_ACTIVE_COMPILATION_CONDITIONS = "{ "DEBUG $(inherited)" if debug else "$(inherited)" }";'
        common += f' ONLY_ACTIVE_ARCH = {"YES" if debug else "NO"};'
        obj('Project' + configuration, f'isa = XCBuildConfiguration; name = {configuration}; buildSettings = {{ {common} }};')
        app = 'COLLECTIVE_BUNDLE_ID = io.collectiveui.macos; PRODUCT_BUNDLE_IDENTIFIER = "$(COLLECTIVE_BUNDLE_ID)"; PRODUCT_NAME = CollectiveUI; GENERATE_INFOPLIST_FILE = YES; INFOPLIST_FILE = Config/Info.plist; CODE_SIGN_ENTITLEMENTS = Config/CollectiveUI.entitlements; CODE_SIGN_IDENTITY = "-"; CODE_SIGN_STYLE = Manual; ENABLE_HARDENED_RUNTIME = YES; COMBINE_HIDPI_IMAGES = YES; LD_RUNPATH_SEARCH_PATHS = "$(inherited) @executable_path/../Frameworks"; CURRENT_PROJECT_VERSION = 1; MARKETING_VERSION = 0.1.0; SUPPORTED_PLATFORMS = macosx;'
        obj('App' + configuration, f'isa = XCBuildConfiguration; name = {configuration}; buildSettings = {{ {app} }};')
        test = 'PRODUCT_BUNDLE_IDENTIFIER = "$(COLLECTIVE_BUNDLE_ID).tests"; PRODUCT_NAME = CollectiveUITests; GENERATE_INFOPLIST_FILE = YES; CODE_SIGN_IDENTITY = "-"; CODE_SIGN_STYLE = Manual; TEST_HOST = "$(BUILT_PRODUCTS_DIR)/CollectiveUI.app/Contents/MacOS/CollectiveUI"; BUNDLE_LOADER = "$(TEST_HOST)"; LD_RUNPATH_SEARCH_PATHS = "$(inherited) @executable_path/../Frameworks @loader_path/../Frameworks";'
        obj('Test' + configuration, f'isa = XCBuildConfiguration; name = {configuration}; buildSettings = {{ COLLECTIVE_BUNDLE_ID = io.collectiveui.macos; {test} }};')
    for prefix in ['Project', 'App', 'Test']:
        obj(prefix + 'Config', f'isa = XCConfigurationList; buildConfigurations = {refs([prefix + "Debug", prefix + "Release"])}; defaultConfigurationIsVisible = 0; defaultConfigurationName = Release;')
    obj('Project', f'isa = PBXProject; attributes = {{ BuildIndependentTargetsInParallel = YES; LastUpgradeCheck = 1600; }}; buildConfigurationList = {identifier("ProjectConfig")}; compatibilityVersion = "Xcode 14.0"; developmentRegion = en; hasScannedForEncodings = 0; knownRegions = (en, Base); mainGroup = {identifier("Root")}; productRefGroup = {identifier("Products")}; projectDirPath = ""; projectRoot = ""; targets = {refs(["AppTarget", "TestTarget"])}; packageReferences = {refs(["Package"])};')
    project = '// !$*UTF8*$!\n{\n\tarchiveVersion = 1;\n\tclasses = {};\n\tobjectVersion = 56;\n\tobjects = {\n' + '\n'.join(objects) + '\n\t};\n\trootObject = ' + identifier('Project') + ';\n}\n'
    app_ref = f'<BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="{identifier("AppTarget")}" BuildableName="CollectiveUI.app" BlueprintName="CollectiveUI" ReferencedContainer="container:CollectiveUI.xcodeproj"/>'
    test_ref = f'<BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="{identifier("TestTarget")}" BuildableName="CollectiveUITests.xctest" BlueprintName="CollectiveUITests" ReferencedContainer="container:CollectiveUI.xcodeproj"/>'
    scheme = f'''<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion="1600" version="1.7">
  <BuildAction parallelizeBuildables="YES" buildImplicitDependencies="YES"><BuildActionEntries>
    <BuildActionEntry buildForTesting="YES" buildForRunning="YES" buildForProfiling="YES" buildForArchiving="YES" buildForAnalyzing="YES">{app_ref}</BuildActionEntry>
  </BuildActionEntries></BuildAction>
  <TestAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.DebuggerFoundation.Launcher.LLDB" shouldUseLaunchSchemeArgsEnv="NO">
    <Testables><TestableReference skipped="NO">{test_ref}</TestableReference></Testables>
    <CommandLineArguments><CommandLineArgument argument="--demo" isEnabled="YES"/></CommandLineArguments>
  </TestAction>
  <LaunchAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.DebuggerFoundation.Launcher.LLDB" launchStyle="0" useCustomWorkingDirectory="NO" ignoresPersistentStateOnLaunch="NO" debugDocumentVersioning="YES">
    <BuildableProductRunnable runnableDebuggingMode="0">{app_ref}</BuildableProductRunnable>
  </LaunchAction>
  <ProfileAction buildConfiguration="Release" shouldUseLaunchSchemeArgsEnv="YES" savedToolIdentifier="" useCustomWorkingDirectory="NO"><BuildableProductRunnable runnableDebuggingMode="0">{app_ref}</BuildableProductRunnable></ProfileAction>
  <AnalyzeAction buildConfiguration="Debug"/><ArchiveAction buildConfiguration="Release" revealArchiveInOrganizer="YES"/>
</Scheme>
'''
    return {'CollectiveUI.xcodeproj/project.pbxproj': project, 'CollectiveUI.xcodeproj/xcshareddata/xcschemes/CollectiveUI.xcscheme': scheme}


if __name__ == '__main__':
    for relative, content in generate().items():
        path = ROOT / relative
        if '--check' in sys.argv:
            if not path.exists() or path.read_text() != content:
                sys.exit(f'{relative} is stale; run python3 macos/scripts/generate-project.py')
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content)
