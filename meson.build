project('docket', 'c',
  version: '1',
  meson_version: '>= 1.2.2'
)

ext_uuid = 'docket@tylerreece.com'
ext_base = 'org.gnome.shell.extensions.docket'
ext_path = '/org/gnome/shell/extensions/docket'

gnome = import('gnome')
i18n = import('i18n')
fs = import('fs')

exp = fs.expanduser('~/.local/share/gnome-shell/extensions')
tmp_dir = join_paths(meson.project_build_root(), ext_uuid)
ext_dir = join_paths(exp, ext_uuid)
gschema_dir = join_paths(tmp_dir, 'schemas')
locale_dir = join_paths(tmp_dir, 'locale')

ext_config = configuration_data()
ext_config.set('EXTENSION_UUID', ext_uuid)
ext_config.set('EXTENSION_VERSION', meson.project_version())
ext_config.set('EXTENSION_BASE', ext_base)
ext_config.set('EXTENSION_PATH', ext_path)

install_subdir(
  'src',
  install_dir: tmp_dir,
  strip_directory: true
)

subdir('data')

meson.add_install_script('glib-compile-schemas', gschema_dir)
meson.add_install_script('sh', '-c',
    'TARGET="' + ext_dir + '" && SOURCE="' + tmp_dir + '" && ' +
    'if [ -d "$TARGET" ]; then ' +
    '  BACKUP="${TARGET}.bak.$$" && ' +
    '  mv "$TARGET" "$BACKUP" && ' +
    '  mv "$SOURCE" "$TARGET" && ' +
    '  rm -rf "$BACKUP"; ' +
    'else ' +
    '  mkdir -p "$(dirname "$TARGET")" && ' +
    '  mv "$SOURCE" "$TARGET"; ' +
    'fi')

if (get_option('build_zip'))
  zip = find_program('zip', required: true)
  zip_file = join_paths(meson.project_build_root(), ext_uuid) + '.zip'
  meson.add_install_script('build-aux/zip.sh', ext_dir, zip_file)
endif

eslint = find_program('eslint', required: false)
npm_root_result = run_command('npm', 'root', '-g', check: false)

if eslint.found() and npm_root_result.returncode() == 0
  test('ESLint', eslint, args: [join_paths(meson.project_source_root(), 'src'),
    '--resolve-plugins-relative-to=' + npm_root_result.stdout().strip() + '/'])
endif
