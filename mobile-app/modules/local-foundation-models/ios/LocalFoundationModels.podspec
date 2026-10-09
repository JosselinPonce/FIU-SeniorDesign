Pod::Spec.new do |s|
  s.name = 'LocalFoundationModels'
  s.version = '0.1.0'
  s.summary = 'Isolated local AI and offline speech diagnostics'
  s.description = 'Development diagnostics for model availability, advisory interpretation, and strictly on-device speech.'
  s.license = { :type => 'MIT' }
  s.author = 'DriveSense'
  s.homepage = 'https://docs.expo.dev/modules/'
  s.source = { :git => 'https://github.com/expo/expo.git' }
  s.platforms = { :ios => '15.1' }
  s.swift_version = '5.9'
  s.static_framework = true
  s.source_files = '**/*.swift'
  s.dependency 'ExpoModulesCore'
  s.frameworks = 'Speech', 'AVFoundation', 'UIKit'
  # Swift autolinks the guarded framework import when the SDK provides it.
  # Do not force framework linkage: older SDKs must compile the fallback.
end
