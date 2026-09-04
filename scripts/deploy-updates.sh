#!/usr/bin/env bash
set -euo pipefail

: "${STELLAN_UPDATE_SSH:?Exemple: deploy@update.stellan.takeos.fr}"
: "${STELLAN_UPDATE_ROOT:?Exemple: /var/www/update.stellan.takeos.fr}"

ssh_options=(-o IdentitiesOnly=yes -o StrictHostKeyChecking=yes)
if [[ -n "${STELLAN_UPDATE_KEY:-}" ]]; then
  ssh_options+=(-i "$STELLAN_UPDATE_KEY")
fi
printf -v rsync_ssh 'ssh'
for option in "${ssh_options[@]}"; do printf -v rsync_ssh '%s %q' "$rsync_ssh" "$option"; done

version=$(node -p "require('./package.json').version")
windows=(
  "dist/Stellan-${version}-win-x64.exe"
  "dist/Stellan-${version}-win-x64.exe.blockmap"
  "dist/latest.yml"
)
linux=(
  "dist/Stellan-${version}-linux-x86_64.AppImage"
  "dist/latest-linux.yml"
)

for file in "${windows[@]}" "${linux[@]}"; do
  [[ -s "$file" ]] || { echo "Fichier de mise à jour absent : $file" >&2; exit 1; }
done

remote_staging="${STELLAN_UPDATE_ROOT}/.staging-${version}-$$"
ssh "${ssh_options[@]}" "$STELLAN_UPDATE_SSH" "mkdir -p '$remote_staging/windows' '$remote_staging/linux' '$STELLAN_UPDATE_ROOT/windows' '$STELLAN_UPDATE_ROOT/linux'"

# Les artefacts et blockmaps sont publiés avant les manifestes. Un client ne
# peut donc jamais découvrir une version dont les fichiers sont incomplets.
rsync -av --checksum -e "$rsync_ssh" "${windows[@]:0:2}" "$STELLAN_UPDATE_SSH:$remote_staging/windows/"
rsync -av --checksum -e "$rsync_ssh" "${linux[0]}" "$STELLAN_UPDATE_SSH:$remote_staging/linux/"
rsync -av --checksum -e "$rsync_ssh" "${windows[2]}" "$STELLAN_UPDATE_SSH:$remote_staging/windows/latest.yml"
rsync -av --checksum -e "$rsync_ssh" "${linux[1]}" "$STELLAN_UPDATE_SSH:$remote_staging/linux/latest-linux.yml"

ssh "${ssh_options[@]}" "$STELLAN_UPDATE_SSH" "set -eu
  cp '$remote_staging/windows/'Stellan-* '$STELLAN_UPDATE_ROOT/windows/'
  cp '$remote_staging/linux/'Stellan-* '$STELLAN_UPDATE_ROOT/linux/'
  ln -sfn 'Stellan-${version}-win-x64.exe' '$STELLAN_UPDATE_ROOT/windows/.Stellan-Windows-x64.exe.next'
  ln -sfn 'Stellan-${version}-linux-x86_64.AppImage' '$STELLAN_UPDATE_ROOT/linux/.Stellan-Linux-x86_64.AppImage.next'
  mv -Tf '$STELLAN_UPDATE_ROOT/windows/.Stellan-Windows-x64.exe.next' '$STELLAN_UPDATE_ROOT/windows/Stellan-Windows-x64.exe'
  mv -Tf '$STELLAN_UPDATE_ROOT/linux/.Stellan-Linux-x86_64.AppImage.next' '$STELLAN_UPDATE_ROOT/linux/Stellan-Linux-x86_64.AppImage'
  mv '$remote_staging/windows/latest.yml' '$STELLAN_UPDATE_ROOT/windows/latest.yml'
  mv '$remote_staging/linux/latest-linux.yml' '$STELLAN_UPDATE_ROOT/linux/latest-linux.yml'
  rm -rf '$remote_staging'"

echo "Stellan ${version} publié sur https://update.stellan.takeos.fr"
