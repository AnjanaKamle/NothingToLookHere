Pod::Spec.new do |s|
  s.name           = 'DeviceKey'
  s.version        = '0.1.0'
  s.summary        = 'Secure Enclave ES256 device key'
  s.description    = 'Generates a non-exportable P-256 key in the Secure Enclave and signs with it after user presence.'
  s.author         = ''
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = {
    :ios => '15.1'
  }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'Security', 'LocalAuthentication', 'CryptoKit'

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
