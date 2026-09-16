#!/bin/bash
# Move stray cv-aaryan-*.pdf files out of the Nextcloud account root and into
# Career-ops/Resumes/ where they belong.
cd "$HOME/career-ops" || exit 1
source scripts/_nc-creds.sh
DAV="http://${NC_HOST}:9080/remote.php/dav/files/${NC_API_USER}"
DRY="${1:-}"

mapfile -t STRAY < <(curl -s -X PROPFIND -H "Depth: 1" -u "$NC_API_USER:$NC_API_PASS" "$DAV/" --max-time 40 \
  | grep -oE '<d:href>[^<]*</d:href>' | sed 's#</\?d:href>##g' \
  | sed 's#.*/files/[^/]*/##' | grep -E '^cv-aaryan-.*\.pdf$')

echo "  stray PDFs in root: ${#STRAY[@]}"
[ "${#STRAY[@]}" -eq 0 ] && exit 0
if [ "$DRY" = "--dry-run" ]; then
  printf '    would move: %s\n' "${STRAY[@]:0:5}"
  echo "    ... and $(( ${#STRAY[@]} > 5 ? ${#STRAY[@]} - 5 : 0 )) more"
  exit 0
fi

moved=0; overwrote=0; failed=0
for f in "${STRAY[@]}"; do
  enc=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "$f")
  code=$(curl -s -o /dev/null -w "%{http_code}" -X MOVE \
    -H "Destination: ${DAV}/Career-ops/Resumes/${enc}" -H "Overwrite: T" \
    -u "$NC_API_USER:$NC_API_PASS" "${DAV}/${enc}" --max-time 40)
  case "$code" in
    201) moved=$((moved+1)) ;;
    204) overwrote=$((overwrote+1)) ;;
    *)   failed=$((failed+1)); echo "    MOVE failed ($code): $f" ;;
  esac
done
echo "  moved: $moved   overwrote existing: $overwrote   failed: $failed"
