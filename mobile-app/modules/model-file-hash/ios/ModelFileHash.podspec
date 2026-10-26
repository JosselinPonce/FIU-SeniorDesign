Pod::Spec.new do |s|
  s.name = 'ModelFileHash'
  s.version = '0.1.0'
  s.summary = 'Streaming SHA-256 for app-private development model files'
  s.description = s.summary
  s.license = { :type => 'MIT' }
  s.author = 'DriveSense'
  s.homepage = 'https://docs.expo.dev/modules/'
  s.source = { :git => 'https://github.com/expo/expo.git' }
  s.platforms = { :ios => '15.1' }
  s.swift_version = '5.9'
  s.static_framework = true
  s.source_files = '**/*.swift'
  s.dependency 'ExpoModulesCore'
  s.frameworks = 'Foundation', 'CryptoKit'
end
