project('task-widget', 'c',
  version: '23',
  meson_version: '>= 1.2.2'
)

ext_uuid = 'task-widget@juozasmiskinis.gitlab.io'
ext_base = 'org.gnome.shell.extensions.task-widget'
ext_path = '/org/gnome/shell/extensions/task-widget'

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
meson.add_install_script('mkdir', '-p', ext_dir)
meson.add_install_script('rm', '-rf', ext_dir)
meson.add_install_script('mv', tmp_dir, ext_dir)

if (get_option('build_zip'))
  zip = find_program('zip', required: true)
  zip_file = join_paths(meson.project_build_root(), ext_uuid) + '.zip'
  meson.add_install_script('build-aux/zip.sh', ext_dir, zip_file)
endif

eslint = find_program('eslint', required: false)
modules = run_command('npm', 'root', '-g', check: true)

if eslint.found()
  test('ESLint', eslint, args: [join_paths(meson.project_source_root(), 'src'),
    '--resolve-plugins-relative-to=' + modules.stdout().strip() + '/'])
endif
