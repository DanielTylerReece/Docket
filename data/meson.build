configure_file(
  input: 'metadata.json.in',
  output: 'metadata.json',
  configuration: ext_config,
  install_dir: tmp_dir
)

gnome.compile_resources(
  ext_base,
  ext_base + '.gresource.xml',
  gresource_bundle: true,
  install: true,
  install_dir: tmp_dir
)

install_data(
  ext_base + '.gschema.xml',
  install_dir: gschema_dir
)

subdir('po')