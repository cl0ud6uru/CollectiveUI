#!/usr/bin/env python3
"""Cloud project/file/entitlement guardrails; this is not an Xcode build or UI test."""
from pathlib import Path
import plistlib
import re
import subprocess
import sys
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
subprocess.run([sys.executable, str(ROOT / 'scripts/generate-project.py'), '--check'], check=True)
project = (ROOT / 'CollectiveUI.xcodeproj/project.pbxproj').read_text()
definitions = re.findall(r'^\s*([A-F0-9]{24}) = \{', project, flags=re.M)
assert len(definitions) == len(set(definitions)), 'Duplicate Xcode object identifier'
references = set(re.findall(r'\b[A-F0-9]{24}\b', project))
assert references == set(definitions), 'Unresolved Xcode object reference'
source_files = re.findall(r'lastKnownFileType = sourcecode.swift; path = "([^"]+)"', project)
assert len(source_files) == len(set(source_files)), 'Duplicate source membership'
for path in source_files:
    assert (ROOT / path).is_file(), f'Missing compiled source {path}'
assert 'MACOSX_DEPLOYMENT_TARGET = 14.0' in project
assert 'SDKROOT = macosx' in project and 'iphoneos' not in project
assert '../ios/CollectiveKit' in project
assert not any('/Voice/' in p or '/LiveActivities/' in p or p.endswith('/DemoArt.swift') for p in source_files)
for file in (ROOT / 'CollectiveUI').rglob('*.swift'):
    assert not re.search(r'\b(UIKit|WKWebView|UIWebView)\b', file.read_text()), str(file)
with (ROOT / 'Config/Info.plist').open('rb') as file:
    info = plistlib.load(file)
assert info['CFBundleURLTypes'][0]['CFBundleURLSchemes'] == ['collectiveui']
assert info['NSAppTransportSecurity'] == {'NSAllowsLocalNetworking': True}
with (ROOT / 'Config/CollectiveUI.entitlements').open('rb') as file:
    assert plistlib.load(file) == {'com.apple.security.app-sandbox': True, 'com.apple.security.network.client': True}
scheme = ET.parse(ROOT / 'CollectiveUI.xcodeproj/xcshareddata/xcschemes/CollectiveUI.xcscheme')
assert scheme.find('.//TestAction/CommandLineArguments/CommandLineArgument').attrib['argument'] == '--demo'
assert all(node.attrib['BlueprintIdentifier'] in definitions for node in scheme.findall('.//BuildableReference'))
print(f'Project guardrails passed: {len(source_files)} Swift files, resolved objects, macOS 14, offline test host, sandbox/ATS.')
