# Capturas da v3.0.1 (carga em segundo plano): python3 dev/shots_v301.py
# Uso (servidor e capturas no mesmo comando):
#   node dev/build.js && (cd dev/out && python3 -m http.server 8765 &) && python3 dev/shots_v301.py
import asyncio, os
from playwright.async_api import async_playwright
URL = 'http://127.0.0.1:8765/index.html'
OUT = os.path.join(os.path.dirname(__file__), 'shots', 'v301')
os.makedirs(OUT, exist_ok=True)

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/home/user/.cache/ms-playwright/chromium_headless_shell-1217/chrome-headless-shell-linux64/chrome-headless-shell')
        erros = []
        for nome, w, h in [('390', 390, 844), ('desktop', 1366, 900)]:
            for tema in ['claro', 'escuro']:
                ctx = await b.new_context(viewport={'width': w, 'height': h}, device_scale_factor=2 if w == 390 else 1)
                await ctx.add_init_script(f"localStorage.setItem('painel-tema','{tema}')")
                pg = await ctx.new_page()
                pg.on('pageerror', lambda e: erros.append(str(e)))
                pg.on('console', lambda m: m.type == 'error' and erros.append(m.text))
                pre = f'{OUT}/{nome}-{tema}'
                ov = lambda: pg.evaluate('document.documentElement.scrollWidth > innerWidth')
                cartoes = 'e=>{e.scrollIntoView({block:"start"}); window.scrollBy(0,-90)}'
                # 1. primeira pintura: Início pronto, os cinco módulos ainda carregando
                await pg.goto(URL + '?lento=1'); await pg.wait_for_selector('#aba-inicio h1'); await pg.wait_for_timeout(300)
                print(nome, tema, 'carregando:', await pg.locator('.cartao-mod.carregando-mod').count(), 'overflow', await ov())
                await pg.screenshot(path=f'{pre}-inicio-carregando.png')
                await pg.locator('#sec-modulos').evaluate(cartoes); await pg.wait_for_timeout(150)
                await pg.screenshot(path=f'{pre}-cartoes-carregando.png')
                # 2. um módulo ainda carregando (Finanças) e um com erro (E-mails); os outros chegaram
                await pg.goto(URL + '?carregando=financas&erro=emails'); await pg.wait_for_selector('#aba-inicio h1'); await pg.wait_for_timeout(900)
                await pg.locator('#sec-modulos').evaluate(cartoes); await pg.wait_for_timeout(150)
                print(nome, tema, 'carregando:', await pg.locator('.cartao-mod.carregando-mod').count(), 'erro:', await pg.locator('.cartao-mod.erro-mod').count(), 'overflow', await ov())
                await pg.screenshot(path=f'{pre}-cartoes-um-carregando.png')
                await pg.click('#tab-mais'); await pg.wait_for_timeout(400)
                await pg.screenshot(path=f'{pre}-menu-mais-carregando.png')
                await pg.click('#menu-mais [data-mod="financas"]'); await pg.wait_for_timeout(300)
                await pg.screenshot(path=f'{pre}-modulo-carregando.png')
                await pg.click('#tab-mais'); await pg.wait_for_timeout(300)
                await pg.click('#menu-mais [data-mod="emails"]'); await pg.wait_for_timeout(300)
                print(nome, tema, 'tentar de novo:', await pg.locator('[data-v3-recarregar]').count(), 'overflow', await ov())
                await pg.screenshot(path=f'{pre}-modulo-erro.png')
                # 3. tudo carregado
                await pg.goto(URL); await pg.wait_for_selector('#aba-inicio h1'); await pg.wait_for_timeout(900)
                print(nome, tema, 'carregados:', await pg.locator('.cartao-mod:not(.carregando-mod):not(.erro-mod)').count(), 'contador:', await pg.locator('#nav-cont-inicio').text_content())
                await pg.locator('#sec-modulos').evaluate(cartoes); await pg.wait_for_timeout(150)
                await pg.screenshot(path=f'{pre}-cartoes-prontos.png')
                await ctx.close()
        print('erros', erros)
        await b.close()
asyncio.run(main())
