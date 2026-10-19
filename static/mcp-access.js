(() => {
  const $ = (id) => document.getElementById(id);
  const dialog = $('mcpDialog');
  let busy = false;
  const labels = { 'files:read': '读文件', 'files:write': '改文件', 'assets:read': '读资产', 'assets:write': '改资产' };
  function message(text, error = false) {
    $('mcpMessage').textContent = text;
    $('mcpMessage').classList.toggle('is-error', error);
  }
  async function request(body) {
    const response = await apiFetch('/api/mcp/tokens', body ? {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    } : { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '连接操作失败');
    return data;
  }
  async function refresh() {
    $('mcpRefresh').disabled = true;
    try {
      const data = await request();
      for (const checkbox of dialog.querySelectorAll('[value$=":write"]')) {
        checkbox.disabled = !data.canWrite;
        if (!data.canWrite) checkbox.checked = false;
      }
      const rows = data.items.map((item) => {
        const row = document.createElement('div'); row.className = 'mcp-token-row';
        const info = document.createElement('div'), title = document.createElement('strong'), detail = document.createElement('small');
        title.textContent = item.name;
        detail.textContent = `${item.scopes.map((s) => labels[s]).join('、')} · ${Date.now() >= item.expiresAt ? '已过期' : '到期'} ${new Date(item.expiresAt).toLocaleDateString()}`;
        info.append(title, detail);
        const revoke = document.createElement('button'); revoke.type = 'button'; revoke.className = 'button ghost danger-button'; revoke.textContent = '撤销';
        revoke.addEventListener('click', async () => {
          if (busy) return;
          busy = true; revoke.disabled = true;
          try {
            await request({ action: 'revoke', id: item.id });
            $('mcpCreated').hidden = true; $('mcpConfig').value = '';
            message('令牌已撤销，Agent 将无法继续使用。');
            await refresh();
          } catch (error) { message(error.message, true); revoke.disabled = false; }
          finally { busy = false; }
        });
        row.append(info, revoke); return row;
      });
      $('mcpTokenList').replaceChildren(...rows);
      if (!rows.length) $('mcpTokenList').textContent = '暂无连接令牌';
      if (!data.enabled) message('服务端已停用 MCP。', true);
    } catch (error) { message(error.message, true); }
    finally { $('mcpRefresh').disabled = false; }
  }
  $('accountMcpBtn').addEventListener('click', async () => {
    closeDialog(accountDialog); showDialog(dialog); message(''); await refresh();
  });
  $('mcpRefresh').addEventListener('click', refresh);
  const close = () => {
    if (busy) return;
    $('mcpPassword').value = ''; $('mcpConfig').value = ''; $('mcpCreated').hidden = true;
    closeDialog(dialog);
  };
  $('mcpClose').addEventListener('click', close);
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); close(); });
  dialog.addEventListener('close', () => {
    $('mcpPassword').value = ''; $('mcpConfig').value = ''; $('mcpCreated').hidden = true;
  });
  $('mcpTokenForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy) return;
    const scopes = [...dialog.querySelectorAll('input[name="scope"]:checked')].map((el) => el.value);
    if (!scopes.length) { message('至少选择一项授权范围。', true); return; }
    busy = true; $('mcpCreate').disabled = true; $('mcpClose').disabled = true;
    try {
      const data = await request({ action: 'create', name: $('mcpName').value, password: $('mcpPassword').value, days: Number($('mcpDays').value), scopes });
      $('mcpConfig').value = JSON.stringify({ mcpServers: { lanshare: { type: 'http', url: location.origin + '/mcp', headers: { Authorization: 'Bearer ' + data.token } } } }, null, 2);
      $('mcpCreated').hidden = false;
      message('已创建。关闭后无法再次查看令牌，请妥善保管连接配置。');
      await refresh();
      $('mcpCreated').scrollIntoView({ block: 'nearest' });
    } catch (error) { message(error.message, true); }
    finally { $('mcpPassword').value = ''; busy = false; $('mcpCreate').disabled = false; $('mcpClose').disabled = false; }
  });
  $('mcpCopy').addEventListener('click', async () => {
    try {
      if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText($('mcpConfig').value);
      else { $('mcpConfig').focus(); $('mcpConfig').select(); if (!document.execCommand('copy')) throw new Error('请选中连接配置后手动复制'); }
      message('连接配置已复制，请勿公开其中的令牌。');
    } catch (error) { message(error.message, true); }
  });
})();
