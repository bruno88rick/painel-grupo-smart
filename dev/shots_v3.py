# Capturas dos módulos v3: python3 dev/shots_v3.py <modulo> [base|integrado]
# Uso (servidor e capturas no mesmo comando):
#   node dev/build.js && (cd dev/out && python3 -m http.server 8765 &) && python3 dev/shots_v3.py suporte base
import asyncio, sys, os
from playwright.async_api import async_playwright
URL = 'http://127.0.0.1:8765/index.html'
MOD = sys.argv[1] if len(sys.argv) > 1 else 'suporte'
FASE = sys.argv[2] if len(sys.argv) > 2 else 'base'
DEC = sys.argv[3] if len(sys.argv) > 3 else 'refazer'
TXT = sys.argv[4] if len(sys.argv) > 4 else 'Trocar o prazo de reembolso para 10 dias úteis; manter o resto.'
DATA = sys.argv[5] if len(sys.argv) > 5 else ''   # campo data do diálogo (aaaa-mm-dd), opcional
VALOR = sys.argv[6] if len(sys.argv) > 6 else ''  # campo valor do diálogo, opcional
OUT = os.path.join(os.path.dirname(__file__), 'shots', 'v3', MOD)
os.makedirs(OUT, exist_ok=True)

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/home/user/.cache/ms-playwright/chromium_headless_shell-1217/chrome-headless-shell-linux64/chrome-headless-shell')
        erros = []
        for nome, w, h in [('390', 390, 844), ('desktop', 1366, 900)]:
            for tema in (['claro', 'escuro'] if FASE == 'base' else ['claro']):
                ctx = await b.new_context(viewport={'width': w, 'height': h}, device_scale_factor=2 if w == 390 else 1)
                await ctx.add_init_script(f"localStorage.setItem('painel-tema','{tema}')")
                pg = await ctx.new_page()
                pg.on('pageerror', lambda e: erros.append(str(e)))
                pg.on('console', lambda m: m.type == 'error' and erros.append(m.text))
                await pg.goto(URL); await pg.wait_for_selector('#aba-inicio h1'); await pg.wait_for_timeout(700)
                pre = f'{OUT}/{nome}-{tema}'
                ov = lambda: pg.evaluate('document.documentElement.scrollWidth > innerWidth')
                if FASE == 'base':
                    await pg.screenshot(path=f'{pre}-inicio.png')
                    await pg.locator('#sec-modulos').evaluate('e=>{e.scrollIntoView({block:"start"}); window.scrollBy(0,-90)}'); await pg.wait_for_timeout(200)
                    await pg.screenshot(path=f'{pre}-inicio-cartoes.png')
                    await pg.click('#tab-mais'); await pg.wait_for_timeout(400)
                    await pg.screenshot(path=f'{pre}-menu-mais.png')
                    await pg.click(f'#menu-mais [data-mod="{MOD}"]'); await pg.wait_for_timeout(500)
                    print(nome, tema, 'overflow modulo:', await ov(), 'botoes desabilitados:', await pg.locator('#aba-mod [data-v3-dec][disabled]').count())
                    await pg.screenshot(path=f'{pre}-modulo.png')
                    await pg.screenshot(path=f'{pre}-modulo-inteiro.png', full_page=True)
                    mo = pg.locator('#aba-mod [data-v3-mostrar]').first
                    if await mo.count():
                        await mo.evaluate('e=>e.scrollIntoView({block:"center"})'); await mo.click(); await pg.wait_for_timeout(200)
                        print(nome, tema, 'overflow codigo:', await ov())
                        await pg.screenshot(path=f'{pre}-codigo.png')
                else:
                    await pg.click('#tab-mais'); await pg.wait_for_timeout(300)
                    await pg.click(f'#menu-mais [data-mod="{MOD}"]'); await pg.wait_for_timeout(500)
                    btn = pg.locator(f'#aba-mod [data-v3-dec="{DEC}"]:not([disabled])').first
                    await btn.evaluate('e=>e.scrollIntoView({block:"center"})')
                    await btn.click(); await pg.wait_for_timeout(400)
                    await pg.screenshot(path=f'{pre}-dialogo.png')
                    if await pg.locator('#v3-campos [required]').count():
                        await pg.click('#v3-enviar'); await pg.wait_for_timeout(300)
                        await pg.screenshot(path=f'{pre}-dialogo-erro.png')
                    for sel, v in (('#v3-campos textarea', TXT), ('#v3-campos input[type=date]', DATA), ('#v3-campos input[type=number]', VALOR)):
                        f = pg.locator(sel).first
                        if v and await f.count(): await f.fill(v)
                    if DATA or VALOR: await pg.screenshot(path=f'{pre}-dialogo-preenchido.png')
                    await pg.click('#v3-enviar'); await pg.wait_for_timeout(700)
                    el = pg.locator('#aba-mod .enviado-v3').first
                    if await el.count(): await el.evaluate('e=>e.scrollIntoView({block:"center"})')
                    print(nome, 'enviado:', await pg.locator('#aba-mod .enviado-v3').count(), 'overflow', await ov())
                    await pg.screenshot(path=f'{pre}-apos-decisao.png')
                await ctx.close()
        print('erros', erros)
        await b.close()
asyncio.run(main())
