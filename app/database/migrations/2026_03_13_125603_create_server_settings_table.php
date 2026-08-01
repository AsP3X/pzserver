<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('server_settings', function (Blueprint $table) {
            $table->id();
            $table->string('server_ip')->default('');
            $table->string('server_port')->default('16261');
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('server_settings');
    }
};
