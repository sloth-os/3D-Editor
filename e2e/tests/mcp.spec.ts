import { test, expect } from '@playwright/test';
import { PLAIN, mcpConnect, newProject, toolJson } from './helpers';

test.describe('MCP agent control', () => {
  test('an AI agent edits the open project live and renders it', async ({ page }) => {
    const id = await newProject(page);
    await expect(page.getByTestId('sync-status')).toHaveAttribute('data-status', 'connected');
    const client = await mcpConnect(PLAIN);
    const tools = (await client.listTools()).tools.map((t) => t.name);
    for (const t of [
      'list_projects',
      'get_scene',
      'add_object',
      'run_operator',
      'render_image',
      'editor_command',
    ])
      expect(tools).toContain(t);

    const projects = toolJson<{ projects: { id: string }[] }>(
      await client.callTool({ name: 'list_projects', arguments: {} }),
    );
    expect(projects.projects.map((p) => p.id)).toContain(id);

    // the agent adds an object: the browser outliner updates live
    await client.callTool({
      name: 'add_object',
      arguments: { project: id, type: 'torus', name: 'AgentTorus', location: [0, 0, 2] },
    });
    await expect(page.getByTestId('outliner-AgentTorus')).toBeVisible();
    // the agent is visible as a peer
    await expect(page.getByTestId('peer-avatar').first()).toBeVisible();

    // generic operator access with Blender-style ids
    const r = await client.callTool({
      name: 'run_operator',
      arguments: {
        project: id,
        operator: 'mesh.primitive_cylinder_add',
        params: { vertices: 12, location: [3, 0, 0] },
      },
    });
    expect((r as { isError?: boolean }).isError).toBeFalsy();
    await expect(page.getByTestId('outliner-Cylinder')).toBeVisible();

    const scene = toolJson<{ objects: { name: string }[] }>(
      await client.callTool({ name: 'get_scene', arguments: { project: id } }),
    );
    expect(scene.objects.map((o) => o.name)).toEqual(
      expect.arrayContaining(['AgentTorus', 'Cylinder', 'Cube']),
    );

    // rendering is delegated to the live browser editor (WebGL)
    const img = (await client.callTool({
      name: 'render_image',
      arguments: { project: id, width: 320, height: 180 },
    })) as {
      content: { type: string; data?: string; mimeType?: string; text?: string }[];
    };
    const image = img.content.find((c) => c.type === 'image');
    expect(image?.mimeType).toBe('image/png');
    expect(Buffer.from(image!.data!, 'base64').subarray(1, 4).toString('ascii')).toBe('PNG');

    // UI commands reach the editor
    await client.callTool({
      name: 'editor_command',
      arguments: { project: id, command: 'notify', params: { message: 'Hello from the agent' } },
    });
    await expect(page.getByTestId('toast').filter({ hasText: 'Hello from the agent' })).toBeVisible();
    await client.close();
  });
});
