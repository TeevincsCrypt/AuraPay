# AuraPay on X (Twitter)

| File | Use |
|---|---|
| `aurapay-x-profile-400.png` | Profile picture (X shows it as a circle). `-800` is a sharper 2× copy. |
| `aurapay-x-header-1500x500.png` | Header image. `-3000x1000` is a sharper 2× copy. |

The header keeps its text clear of the profile picture (bottom-left) and of the top/bottom strips X crops on phones.

To edit the text, change `header.html` / `profile.html` and re-render them at 1500×500 / 400×400 (e.g. with Playwright `page.screenshot`).
