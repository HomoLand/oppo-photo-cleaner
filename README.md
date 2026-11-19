# OPPO Cloud Photo Bulk Delete

Tampermonkey userscript for managing OPPO / HeyTap / OnePlus cloud photos from the web app.

It is built for two real workflows:

- Clear cloud photo data so the phone can upload/sync a fresh copy later.
- Permanently remove cloud-side photo/video data, including recycle bin contents.

## Features

- Scan normal photo library and recycle bin.
- Filter by media type, date range, and filename.
- Export scan results as JSON before making changes.
- Move filtered normal-library results to recycle bin.
- Permanently delete filtered recycle-bin results.
- Clear the whole recycle bin, with a batch-delete fallback when OPPO's bulk API fails.
- Restore the whole recycle bin or filtered recycle-bin results.
- Clear the current cloud data source end to end: normal library -> recycle bin -> permanent deletion.

## Install

Install a userscript manager such as Tampermonkey, then open:

https://raw.githubusercontent.com/HomoLand/oppo-photo-cleaner/main/oppo-cloud-photo-bulk-delete.user.js

## Usage

1. Open the OPPO cloud photo web app:
   - https://cloud.oppo.com/module.html#/photo
   - https://cloud.heytap.com/module.html#/photo
   - https://cloud.oneplus.com/module.html#/photo
2. Log in normally.
3. Confirm on the phone that photo cloud sync / automatic backup is disabled if you want to protect local files from cloud-side deletion effects.
4. Confirm you have a local copy or backup.
5. Use `初始化并读取计数`, then choose the operation you need.

The main `清空云端相册` action always processes the current data source in full. Advanced filters only affect scan/export and filtered-result operations.

## Safety Notes

This script calls the same encrypted request layer used by the web app, but it performs destructive operations. Permanent deletion cannot be undone unless OPPO still has a server-side recovery path outside the normal recycle-bin flow.

Before bulk deletion:

- Turn off photo cloud sync / automatic backup on the phone if local files must be preserved.
- Keep an independent local backup.
- Run a scan and export the JSON manifest if you need an audit trail.
- Start with a smaller batch size if the web app or service is unstable.

## Development

The script is plain JavaScript with no build step.

```powershell
node --check .\oppo-cloud-photo-bulk-delete.user.js
```

## Disclaimer

This project is not affiliated with OPPO, HeyTap, or OnePlus. Product names are trademarks of their respective owners.

Use at your own risk.

## License

MIT
