import asyncio
from playwright.async_api import async_playwright
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/home/user/.cache/ms-playwright/chromium_headless_shell-1217/chrome-headless-shell-linux64/chrome-headless-shell')
        pg = await b.new_page(viewport={'width':390,'height':844}, device_scale_factor=2)
        await pg.goto('http://127.0.0.1:8765/index.html'); await pg.wait_for_selector('#aba-inicio h1'); await pg.wait_for_timeout(600)
        await pg.screenshot(path='shots/390-claro-aviso-fonte.png')
        await pg.click('#aba-inicio [data-ajuste="P-20261111-03"]'); await pg.wait_for_timeout(300)
        await pg.screenshot(path='shots/390-claro-ajuste.png')
        await b.close()
asyncio.run(main())
